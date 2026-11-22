// Custom hotword/homophone corrections — the "custom words" every leading
// dictation tool ships (Superwhisper, Wispr Flow). STT mishears niche terms
// and homophones (会话→绘画); a user-edited map fixes them right after
// transcription, before the text reaches the DSH session.
//
// File: ~/.dsh/nico/corrections.json — flat map, misheard → corrected:
//   { "深度seek": "DeepSeek", "新会话按钮": "新会话按钮" }
// Read per call: the file is tiny and edits take effect on the next voice
// command with no daemon restart.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NICO_DIR } from './paths.mjs'

export function correctionsFile() {
  return join(NICO_DIR, 'corrections.json')
}

// Returns a plain { misheard: corrected } map; anything invalid is skipped.
export function loadCorrections() {
  const f = correctionsFile()
  if (!existsSync(f)) return {}
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8'))
    const out = {}
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
    for (const [k, v] of Object.entries(raw)) {
      if (typeof k === 'string' && typeof v === 'string' && k && v) out[k] = v
    }
    return out
  } catch { return {} }
}

// Settings-injected map (GUI volatile leaf → index.js mirror). Wins over the
// file while present; null/empty clears back to the file.
let injected = null
export function setCorrections(map) {
  injected = map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).length ? map : null
}

export function activeCorrections() {
  return injected || loadCorrections()
}

// Longest-key-first replacement so longer entries win over their prefixes.
export function applyCorrections(text, map = activeCorrections()) {
  const t = String(text || '')
  if (!t || !map) return t
  let out = t
  for (const key of Object.keys(map).sort((a, b) => b.length - a.length)) {
    if (out.includes(key)) out = out.split(key).join(map[key])
  }
  return out
}
