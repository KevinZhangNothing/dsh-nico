// TTS routing for Nico replies.
//   engine 'say' (default) → macOS built-in `say`, system default voice.
//   engine 'cosyvoice'     → a local CosyVoice2 deployment exposing the
//                            OpenAI-compatible POST /v1/audio/speech; played
//                            with ffplay (streamed PCM — playback starts on the
//                            first generated chunk) or afplay (whole wav, only
//                            when ffplay is unavailable / the server is old).
//                            Any CosyVoice failure falls back to `say` so a
//                            reply is never dropped.
// Playback is async (spawn, not spawnSync) so the hotkey loop is never
// blocked while a reply is being spoken.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { existsSync, unlinkSync } from 'node:fs'

export const TTS_DEFAULT_URL = 'http://127.0.0.1:59993/v1'

// Host schema uses '' for absent values; the voice flow needs concrete fields.
export function normalizeTtsSelection(sel) {
  const s = sel && typeof sel === 'object' ? sel : {}
  return {
    engine: s.engine === 'cosyvoice' ? 'cosyvoice' : 'say',
    url: String(s.url || TTS_DEFAULT_URL).replace(/\/+$/, ''),
    model: s.model || 'cosyvoice-2',
    voice: s.voice || '',
    // CosyVoice2 instruct2 emotion directive, e.g. 用开心的语气说.
    instruct: (s.instruct || '').trim(),
    speed: Number(s.speed) > 0 ? Number(s.speed) : 1.0,
  }
}

// ffplay is the streaming player; probe once, lazily (missing binary → wav/afplay path).
let ffplayOk = null
function hasFfplay() {
  if (ffplayOk === null) {
    try { ffplayOk = spawnSync('ffplay', ['-version'], { stdio: 'ignore' }).status === 0 } catch { ffplayOk = false }
  }
  return ffplayOk
}

function playWav(file, onPlaying) {
  return new Promise((resolve) => {
    try {
      const p = spawn('afplay', [file], { stdio: 'ignore' })
      if (typeof onPlaying === 'function') onPlaying()   // afplay starts almost instantly
      p.on('exit', () => resolve(true))
      p.on('error', () => resolve(false))
    } catch { resolve(false) }
  })
}

function saySay(text, onPlaying) {
  return new Promise((resolve) => {
    try {
      const p = spawn('say', [text], { stdio: 'ignore' })
      if (typeof onPlaying === 'function') onPlaying()
      p.on('exit', () => resolve({ engine: 'say', ok: true }))
      p.on('error', (e) => resolve({ engine: 'say', ok: false, error: e?.message || String(e) }))
    } catch (e) { resolve({ engine: 'say', ok: false, error: e?.message || String(e) }) }
  })
}

// POST the request as raw-PCM and pipe the response into ffplay as it arrives.
// Outcome codes:
//   'ok'      → full audio played
//   'partial' → playback started but ended early (player death); do NOT retry —
//               the user already heard something, a fallback would double-speak
//   'fail'    → nothing was played (fetch failed / no chunks / player missing),
//               safe to fall back to the wav/afplay path
async function playPcmStream(text, sel, onPlaying) {
  let res
  try {
    res = await fetch(sel.url + '/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: sel.model,
        input: sel.instruct ? sel.instruct + '<|endofprompt|>' + text : text,
        ...(sel.voice ? { voice: sel.voice } : {}),
        speed: sel.speed,
        response_format: 'pcm',
      }),
    })
  } catch { return 'fail' }
  if (!res.ok || !res.body) return 'fail'
  const rate = parseInt(res.headers.get('x-sample-rate') || '24000', 10) || 24000
  return await new Promise((resolve) => {
    let ff
    try {
      ff = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet',
        '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', '-'], { stdio: ['pipe', 'ignore', 'ignore'] })
    } catch { return resolve('fail') }
    let started = false
    let wroteAny = false
    let settled = false
    const done = (code) => { if (!settled) { settled = true; resolve(wroteAny ? code : 'fail') } }
    ff.on('error', () => done('fail'))                       // binary missing/unusable → nothing played
    ff.on('exit', (code) => done(code === 0 ? 'ok' : 'partial'))
    ff.stdin.on('error', () => { try { ff.kill() } catch {} })
    ;(async () => {
      try {
        for await (const chunk of res.body) {
          wroteAny = true
          if (!started) { started = true; if (typeof onPlaying === 'function') onPlaying() }
          if (!ff.stdin.write(chunk)) await new Promise((r) => ff.stdin.once('drain', r))
        }
        ff.stdin.end()
      } catch {
        try { ff.kill() } catch {}
        done(wroteAny ? 'partial' : 'fail')
      }
    })()
  })
}

/**
 * Speak one reply. Fire-and-forget friendly (never throws).
 * onPlaying fires when audio ACTUALLY starts reaching the ears (not when
 * synthesis begins) so UI "speaking" states stay honest.
 * @returns {Promise<{engine: string, ok: boolean, error?: string}>}
 */
export async function speakText(text, selection, onPlaying) {
  if (!text) return { engine: 'say', ok: true }
  const sel = normalizeTtsSelection(selection)
  if (sel.engine === 'cosyvoice') {
    if (hasFfplay()) {
      let outcome
      try { outcome = await playPcmStream(text, sel, onPlaying) } catch { outcome = 'fail' }
      if (outcome === 'ok') return { engine: 'cosyvoice', ok: true }
      if (outcome === 'partial') return { engine: 'cosyvoice', ok: false, error: 'playback ended early' }
      // 'fail' → nothing played, fall through to the wav path.
    }
    try {
      const input = sel.instruct ? sel.instruct + '<|endofprompt|>' + text : text
      const res = await fetch(sel.url + '/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: sel.model,
          input,
          ...(sel.voice ? { voice: sel.voice } : {}),
          speed: sel.speed,
          response_format: 'wav',
        }),
      })
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200)
        throw new Error('HTTP ' + res.status + (detail ? ' ' + detail : ''))
      }
      // One unique file per speak: afplay streams from the file, so a shared
      // path lets a concurrent synthesis (re-apply double-speak, manual test)
      // overwrite the audio mid-playback and the user hears the wrong text.
      const wav = join(tmpdir(), 'nico-tts-' + Date.now() + '-' + randomBytes(4).toString('hex') + '.wav')
      await writeFile(wav, Buffer.from(await res.arrayBuffer()))
      const ok = await playWav(wav, onPlaying)
      try { if (existsSync(wav)) unlinkSync(wav) } catch {}
      if (ok) return { engine: 'cosyvoice', ok: true }
      throw new Error('afplay 无法播放返回的音频')
    } catch (e) {
      // Fall back to `say` on any CosyVoice failure.
      const r = await saySay(text, onPlaying)
      return { ...r, fallback: true, error: e?.message || String(e) }
    }
  }
  return saySay(text, onPlaying)
}
