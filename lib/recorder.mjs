// Mic recording via ffmpeg (avfoundation). The audio device index is resolved
// from the live device list instead of hardcoding :0: a virtual input (e.g.
// MiRemoteV, LarkAudioDevice) can take index 0 and silently record digital
// silence, which looked like "stuck in Listening" (empty transcripts).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createSilenceWatcher } from './vad.mjs'

const LIST_ARGS = ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']

// Parse ffmpeg's avfoundation device listing and prefer the built-in mic over
// virtual/aggregate inputs. Pure so the selection is testable.
export function pickAudioDevice(text) {
  const lines = String(text || '').split('\n')
  const devices = []
  let inAudio = false
  for (const line of lines) {
    if (/AVFoundation audio devices:/.test(line)) { inAudio = true; continue }
    if (!inAudio) continue
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/)
    if (m) devices.push({ index: Number(m[1]), name: m[2] })
  }
  if (!devices.length) return null
  const preferred = devices.find((d) => /MacBook|Built-?in|Microphone|麦克风|内建/i.test(d.name))
  return (preferred || devices[0]).index
}

function normalizeDevice(v) {
  const s = String(v || '').trim()
  if (!s) return null
  return /^\d+$/.test(s) ? ':' + s : s
}

let device = normalizeDevice(process.env.NICO_AUDIO_DEVICE)
let resolving = null

// Async warm-up: called when the voice loop starts, long before the first
// recording, so resolving the device adds no latency to hold-to-talk.
export function resolveAudioDevice() {
  if (device) return Promise.resolve(device)
  if (resolving) return resolving
  resolving = new Promise((resolve) => {
    let log = ''
    let child
    try {
      child = spawn('ffmpeg', LIST_ARGS, { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch {
      resolve(fallbackDevice())
      return
    }
    child.stderr?.on('data', (d) => { log = (log + d.toString()).slice(-8000) })
    child.on('error', () => resolve(fallbackDevice()))
    child.on('close', () => {
      const index = pickAudioDevice(log)
      if (index !== null) device = ':' + index
      resolve(fallbackDevice())
    })
  })
  return resolving
}

// Synchronous last resort for a recording that starts before warm-up finished
// (bare CLI / first hotkey press immediately after launch).
export function resolveAudioDeviceSync() {
  if (device) return device
  try {
    const r = spawnSync('ffmpeg', LIST_ARGS, { encoding: 'utf8', timeout: 5000 })
    const index = pickAudioDevice(r.stderr || '')
    if (index !== null) device = ':' + index
  } catch {}
  return fallbackDevice()
}

function fallbackDevice() {
  return device || ':0'
}

// Start recording and return a handle; call handle.stop() on hotkey up, then await handle.done.
// silenceSec + onEndpoint enable hands-free endpointing: -af silencedetect
// runs on the same capture, and the watcher fires onEndpoint once the first
// silence window AFTER speech exceeds silenceSec. loglevel must be info so
// silencedetect lines reach stderr (error level would hide them).
export function startRecording({ device: requested = null, maxSec = 30, silenceSec = null, onEndpoint = null } = {}) {
  const dev = normalizeDevice(requested) || resolveAudioDeviceSync()
  const out = '/tmp/nico_mic_' + Date.now() + '.wav'
  const args = ['-hide_banner', '-loglevel', silenceSec ? 'info' : 'error',
    '-f', 'avfoundation', '-i', dev, '-ar', '16000', '-ac', '1']
  if (silenceSec) args.push('-af', 'silencedetect=noise=-35dB:d=' + silenceSec)
  args.push('-t', String(maxSec), out)
  const child = spawn('ffmpeg', args)
  const timer = setTimeout(() => { try { child.kill('SIGINT') } catch {} }, maxSec * 1000 + 500)
  const watcher = silenceSec && onEndpoint ? createSilenceWatcher({ onEndpoint }) : null
  let stderr = ''
  child.stderr?.on('data', (d) => {
    const s = d.toString()
    stderr = (stderr + s).slice(-4000)
    if (watcher) for (const line of s.split('\n')) { if (line) watcher.feed(line) }
  })
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
