// TTS routing for Nico replies.
//   engine 'say' (default) → macOS built-in `say`, system default voice.
//   engine 'cosyvoice'     → a local CosyVoice2 deployment exposing the
//                            OpenAI-compatible POST /v1/audio/speech; the
//                            returned wav is played with `afplay`. Any
//                            CosyVoice failure falls back to `say` so a
//                            reply is never dropped.
// Playback is async (spawn, not spawnSync) so the hotkey loop is never
// blocked while a reply is being spoken.
import { spawn } from 'node:child_process'
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

function playWav(file) {
  return new Promise((resolve) => {
    try {
      const p = spawn('afplay', [file], { stdio: 'ignore' })
      p.on('exit', () => resolve(true))
      p.on('error', () => resolve(false))
    } catch { resolve(false) }
  })
}

function saySay(text) {
  return new Promise((resolve) => {
    try {
      const p = spawn('say', [text], { stdio: 'ignore' })
      p.on('exit', () => resolve({ engine: 'say', ok: true }))
      p.on('error', (e) => resolve({ engine: 'say', ok: false, error: e?.message || String(e) }))
    } catch (e) { resolve({ engine: 'say', ok: false, error: e?.message || String(e) }) }
  })
}

/**
 * Speak one reply. Fire-and-forget friendly (never throws).
 * @returns {Promise<{engine: string, ok: boolean, error?: string}>}
 */
export async function speakText(text, selection) {
  if (!text) return { engine: 'say', ok: true }
  const sel = normalizeTtsSelection(selection)
  if (sel.engine === 'cosyvoice') {
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
      const ok = await playWav(wav)
      try { if (existsSync(wav)) unlinkSync(wav) } catch {}
      if (ok) return { engine: 'cosyvoice', ok: true }
      throw new Error('afplay 无法播放返回的音频')
    } catch (e) {
      // Fall back to `say` on any CosyVoice failure.
      const r = await saySay(text)
      return { ...r, fallback: true, error: e?.message || String(e) }
    }
  }
  return saySay(text)
}
