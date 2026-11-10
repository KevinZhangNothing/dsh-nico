// Mic recording via ffmpeg (avfoundation device :0).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export function record({ device = ':0', maxSec = 30, onTick } = {}) {
  return new Promise((resolve) => {
    const out = '/tmp/nico_mic_' + Date.now() + '.wav'
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
      '-f', 'avfoundation', '-i', device, '-ar', '16000', '-ac', '1', '-t', String(maxSec), out])
    // Hard stop after maxSec (ffmpeg -t should self-stop, but be safe).
    const timer = setTimeout(() => { try { child.kill('SIGINT') } catch {} }, maxSec * 1000 + 500)
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message, wav: null }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0 && existsSync(out), wav: existsSync(out) ? out : null, code })
    })
    this.child = child
    // allow external stop (hotkey up) to terminate early
    this.stop = () => { try { child.kill('SIGINT') } catch {} }
  })
}

// Start recording and return a handle; call handle.stop() on hotkey up, then await handle.done.
export function startRecording({ device = ':0', maxSec = 30 } = {}) {
  const out = '/tmp/nico_mic_' + Date.now() + '.wav'
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'avfoundation', '-i', device, '-ar', '16000', '-ac', '1', '-t', String(maxSec), out])
  const timer = setTimeout(() => { try { child.kill('SIGINT') } catch {} }, maxSec * 1000 + 500)
  let stderr = ''
  child.stderr?.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000) })
  const done = new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timer)
      // ffmpeg exits 255 on the SIGINT we intentionally send when right-⌘ is
      // released. That is a successful short recording, not a recorder failure.
      const stoppedCleanly = code === 0 || (stopped && existsSync(out))
      resolve({ ok: stoppedCleanly && existsSync(out), wav: existsSync(out) ? out : null, code, error: stoppedCleanly ? null : stderr.trim() })
    })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message, wav: null }) })
  })
  let stopped = false
  return {
    wav: out,
    done,
    stop() { if (!stopped) { stopped = true; try { child.kill('SIGINT') } catch {} } },
  }
}
