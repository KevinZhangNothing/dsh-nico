// Voice-action orchestration shared by the `nico` CLI daemon and the cordis
// parasite entrypoint. Holds one right-⌘ Hotkey; on 'down' starts a mic
// recording, on 'up' transcribes and routes through the fixed headless session.
//
// Kept as a plain function (not tied to a CLI argv) so the cordis `apply`
// can drive the exact same hold-to-talk loop that `nico daemon` does —
// one implementation, two hosts.
import { EventEmitter } from 'node:events'
import { Hotkey } from './hotkey.mjs'
import { startRecording } from './recorder.mjs'
import { transcribe, setSttSelection } from './stt.mjs'
import { runCommand } from './dsh.mjs'

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
      this.emit('transcript', text, { engine, model })
      if (!text) return
      const { reply, ok, reason } = await runCommand(text)
      this.emit('reply', { ok, reply, reason, text })
      this.say(reply)
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
    if (this._rec) { try { this._rec.stop() } catch {}; this._rec = null }
    if (this._hk) { this._hk.stop(); this._hk = null }
  }
}

export function startNicoVoice(opts = {}) {
  return new NicoVoice(opts).start()
}
