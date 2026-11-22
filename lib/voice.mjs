// Voice-action orchestration shared by the `nico` CLI daemon and the cordis
// parasite entrypoint. Holds one right-⌘ Hotkey; on 'down' starts a mic
// recording, on 'up' transcribes and routes through the fixed headless session.
//
// Kept as a plain function (not tied to a CLI argv) so the cordis `apply`
// can drive the exact same hold-to-talk loop that `nico daemon` does —
// one implementation, two hosts.
import { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Hotkey } from './hotkey.mjs'
import { startRecording, resolveAudioDevice } from './recorder.mjs'
import { transcribe, setSttSelection } from './stt.mjs'
import { runCommand } from './dsh.mjs'
import { stopSpeaking } from './tts.mjs'

// Safety net for the bootstrap contract: the session is told to answer in one
// or two short spoken sentences, but if it still returns a long task report,
// only the leading text (cut at the last sentence boundary) is spoken, so a
// task result never turns into a minute-long monologue. The full reply is
// still emitted on 'reply' for the bubble UI.
const MAX_SPOKEN_CHARS = 100

// Hands-free switch: injected by the host (settings accessor) or set by
// NICO_HANDS_FREE=1 for the bare CLI. When on, the mic reopens automatically
// after each spoken reply (and after an empty utterance), and silence
// endpointing submits the utterance without a hotkey release.
let handsFreeFn = null
export function setHandsFree(fn) { handsFreeFn = fn || null }
function handsFreeOn() {
  return handsFreeFn?.() === true || process.env.NICO_HANDS_FREE === '1'
}
// Change-your-mind utterances: a whole-utterance 「算了 / 取消 / 不要了」 is a
// withdrawal, not a task — sending it to the session would both pollute the
// fixed context and make her act on nothing. Only matches when the ENTIRE
// utterance is a withdrawal (optionally with sentence-final particles), so
// 「算了，还是把桌面整理一下」 still goes through.
const CANCEL_RE = /^[，,。\s]*((算了|取消|不要了|没事了|不说了|好了|好啦|cancel( it)?|never ?mind)(啊|吧|呀|哦|啦|了)*)+[。！！？?!~\s，,]*$/i
export function isCancelCommand(text) {
  return CANCEL_RE.test(String(text || '').trim())
}

export function speakable(text) {
  const t = String(text || '').trim()
  if (t.length <= MAX_SPOKEN_CHARS) return t
  const head = t.slice(0, MAX_SPOKEN_CHARS)
  const m = head.match(/[\s\S]*[。！？!?；;\n]/)
  return ((m ? m[0] : head).trim()) + '……'
}

export class NicoVoice extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.maxSec = opts.maxSec ?? 30
    this.say = opts.say || (() => {})   // speak the reply; CLI wires `say`, parasite may no-op
    this.sttSelection = opts.sttSelection || null
    this.routeLabel = opts.routeLabel || null
    this._hk = null
    this._rec = null
    this._hfTimer = null
    this._deniedReported = false
    this._gen = 0      // increments on stop(); in-flight say() from a dead instance is dropped
  }

  start() {
    // Warm the avfoundation device list while the host finishes booting, so the
    // first hold-to-talk records the built-in mic without a resolution delay.
    void resolveAudioDevice()
    if (this.sttSelection) setSttSelection(this.sttSelection)
    const hk = new Hotkey()
    this._hk = hk
    hk.on('down', () => this._onDown())
    hk.on('up', () => this._onUp())
    hk.on('media-toggle-start', () => this._onDown())
    hk.on('media-toggle-stop', () => this._onUp())
    hk.on('ready', () => this.emit('ready'))
    hk.on('permission-denied', (info) => this._denied(info))
    hk.on('stderr', (s) => this.emit('stderr', s))
    hk.on('error', (e) => this.emit('error', e))
    hk.on('exit', (code, signal) => this.emit('exit', code, signal))
    hk.start()
    return this
  }

  _onDown() {
    this._beginRec()
  }

  // Shared by hotkey-down (silenceSec null: end on hotkey release) and
  // hands-free auto-listen (silenceSec set: end on the first silence window
  // after speech). Kept inert when a recording is already live either way.
  _beginRec(silenceSec = null) {
    if (this._rec) return
    // 新任务进入：上一条没播完的播报立即停，不再继续。
    stopSpeaking()
    this.emit('rec-start')
    const rec = startRecording({
      maxSec: this.maxSec,
      silenceSec,
      onEndpoint: silenceSec ? () => { this._hfTimer = setTimeout(() => { this._hfTimer = null; this._onUp() }, 120) } : null,
    })
    this._rec = rec
    // maxSec 到点 ffmpeg 自停：done 在热键仍按住时 resolve（_onUp 会先清
    // this._rec 再等 done，因此此处命中即「还在按着但录音已停」）。提示用户
    // 长句尾部被截断，而不是静默丢音。
    rec.done.then((r) => {
      if (this._rec !== rec || !r.ok) return
      this.emit('rec-capped', { maxSec: this.maxSec })
      // Hands-free has no hotkey-up to submit a capped recording — auto-submit
      // or the loop dies with the recording still parked in this._rec.
      if (handsFreeOn()) this._onUp()
    }).catch(() => {})
  }

  // Hands-free loop driver: reopen the mic shortly after a spoken reply (or an
  // empty utterance). Guarded per-fire so stop()/flag-off mid-timer is safe.
  _autoListen() {
    if (!handsFreeOn() || this._rec || this._hfTimer) return
    this._hfTimer = setTimeout(() => {
      this._hfTimer = null
      if (!handsFreeOn() || this._rec) return
      this._beginRec(1.0)
    }, 350)
  }

  async _onUp() {
    const rec = this._rec
    if (!rec) return
    this._rec = null
    rec.stop()
    const r = await rec.done
    if (!r.ok || !r.wav) { this.emit('rec-fail', r); this._autoListen(); return }
    try {
      const { text, engine, model } = await transcribe(r.wav, this.sttSelection)
      // Full transcript text to disk: the host swallows console.error and the
      // index.js diag only records the length, so STT mishears (homophones
      // like 会话→绘画) were previously invisible.
      try {
        mkdirSync(join(homedir(), '.dsh', 'nico'), { recursive: true })
        appendFileSync(join(homedir(), '.dsh', 'nico', 'apply.log'),
          new Date().toISOString() + ' [dsh-nico] transcript: ' + text + '\n')
      } catch {}
      this.emit('transcript', text, { engine, model })
      if (!text) { this._autoListen(); return }
      if (isCancelCommand(text)) {
        this.emit('cancel', { text })
        const ack = '好的。'
        this.emit('reply', { ok: true, reply: ack, text })
        this.emit('tts-start', { reply: ack })
        await this.say(speakable(ack), () => this.emit('tts-playing', { reply: ack }))
        this.emit('tts-done', { reply: ack })
        this._autoListen()
        return
      }
      const gen = this._gen
      const { reply, ok, reason } = await runCommand(text, {
        // Stream task steps to the bubble while the run is live. Dropped when
        // this instance was stopped mid-command (same generation guard as say).
        onProgress: (ev) => { if (this._gen === gen) this.emit('progress', ev) },
      })
      if (this._gen !== gen) return   // instance was stopped mid-command; its say() would overlap the new instance's speech
      this.emit('reply', { ok, reply, reason, text })
      this.emit('tts-start', { reply })
      // onPlaying fires when audio actually reaches the speaker (synthesis can
      // take ~10s on CPU); the UI moves to the speaking state there, not here.
      await this.say(speakable(reply), () => this.emit('tts-playing', { reply }))
      this.emit('tts-done', { reply })
      this._autoListen()
    } catch (e) {
      this.emit('reply', { ok: false, reply: '执行失败：' + (e?.message || e) })
      this._autoListen()
    }
  }

  _denied(info) {
    if (this._deniedReported) return
    this._deniedReported = true
    this.emit('permission-denied', info)
  }

  stop() {
    this._gen++
    if (this._hfTimer) { clearTimeout(this._hfTimer); this._hfTimer = null }
    if (this._rec) { try { this._rec.stop() } catch {}; this._rec = null }
    if (this._hk) { this._hk.stop(); this._hk = null }
  }
}

export function startNicoVoice(opts = {}) {
  return new NicoVoice(opts).start()
}
