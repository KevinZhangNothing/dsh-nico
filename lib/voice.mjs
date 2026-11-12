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
import { startRecording } from './recorder.mjs'
import { transcribe, setSttSelection } from './stt.mjs'
import { runCommand } from './dsh.mjs'
import { stopSpeaking } from './tts.mjs'

// Safety net for the bootstrap contract: the session is told to answer in one
// or two short spoken sentences, but if it still returns a long task report,
// only the leading text (cut at the last sentence boundary) is spoken, so a
// task result never turns into a minute-long monologue. The full reply is
// still emitted on 'reply' for the bubble UI.
const MAX_SPOKEN_CHARS = 100
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
    this._deniedReported = false
    this._gen = 0      // increments on stop(); in-flight say() from a dead instance is dropped
  }

  start() {
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
    if (this._rec) return
    // 新任务进入：上一条没播完的播报立即停，不再继续。
    stopSpeaking()
    this.emit('rec-start')
    this._rec = startRecording({ maxSec: this.maxSec })
  }

  async _onUp() {
    const rec = this._rec
    if (!rec) return
    this._rec = null
    rec.stop()
    const r = await rec.done
    if (!r.ok || !r.wav) { this.emit('rec-fail', r); return }
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
      if (!text) return
      const gen = this._gen
      const { reply, ok, reason } = await runCommand(text)
      if (this._gen !== gen) return   // instance was stopped mid-command; its say() would overlap the new instance's speech
      this.emit('reply', { ok, reply, reason, text })
      this.emit('tts-start', { reply })
      // onPlaying fires when audio actually reaches the speaker (synthesis can
      // take ~10s on CPU); the UI moves to the speaking state there, not here.
      await this.say(speakable(reply), () => this.emit('tts-playing', { reply }))
      this.emit('tts-done', { reply })
    } catch (e) {
      this.emit('reply', { ok: false, reply: '执行失败：' + (e?.message || e) })
    }
  }

  _denied(info) {
    if (this._deniedReported) return
    this._deniedReported = true
    this.emit('permission-denied', info)
  }

  stop() {
    this._gen++
    if (this._rec) { try { this._rec.stop() } catch {}; this._rec = null }
    if (this._hk) { this._hk.stop(); this._hk = null }
  }
}

export function startNicoVoice(opts = {}) {
  return new NicoVoice(opts).start()
}
