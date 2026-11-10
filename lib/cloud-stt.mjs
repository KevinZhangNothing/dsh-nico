// Cloud ASR over a provider's OpenAI-compatible endpoint.
// POST /v1/audio/transcriptions with a 16k mono wav; returns the recognized text.
//
// The endpoint is NOT hardcoded: it is read from the host's own model config
// (lib/models.mjs resolveProviderEndpoint → llm service → provider entry).
// The provider is resolved from the nico STT selection (stt.cloudProvider,
// settable in the settings GUI), or falls back to the selected reasoning
// provider when the host exposes a config for it. The API key follows the
// provider entry's apiKeyEnv, or ~/.dsh/.credentials.yaml as a last resort.
// Only invoked when nico settings select stt.engine === 'cloud'; local
// SenseVoice remains the default and needs no network.
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveProviderEndpoint } from './models.mjs'

let llmService = null
export function setLlmService(s) { llmService = s || null }

function credential(name) {
  if (!name) return null
  if (process.env[name]) return process.env[name]
  const f = join(homedir(), '.dsh', '.credentials.yaml')
  if (!existsSync(f)) return null
  try {
    for (const ln of readFileSync(f, 'utf8').split('\n')) {
      const m = ln.match(new RegExp('^\\s{2}' + name + ':\\s*(\\S.*)\\s*$'))
      if (m) return m[1]
    }
  } catch {}
  return null
}

/**
 * Recognize a wav file via a cloud ASR model.
 * @param wavPath - absolute path to a 16k mono 16-bit wav.
 * @param model - the ASR model id (e.g. 'qwen3-asr').
 * @param opts - { cloudProvider?, reasoningProvider? } provider ids to resolve
 * @returns the recognized text (may be '').
 */
export async function transcribeCloud(wavPath, model, opts = {}) {
  const candidates = [opts.cloudProvider, opts.reasoningProvider].filter(Boolean)
  if (!candidates.length) throw new Error('cloud STT: no provider configured')
  let lastError = null
  for (const provider of candidates) {
    const endpoint = await resolveProviderEndpoint(llmService, provider)
    if (!endpoint || !endpoint.baseUrl) { lastError = new Error('cloud STT: host has no endpoint for provider ' + provider); continue }
    const key = credential(endpoint.apiKeyEnv) || credential('DSH_LARK_NOTHING_LLM_API_KEY')
    if (!key) { lastError = new Error('cloud STT: no API key (env ' + (endpoint.apiKeyEnv || 'none') + ')'); continue }
    const base = endpoint.baseUrl.replace(/\/+$/, '')
    const body = new FormData()
    body.append('model', model)
    body.append('file', new Blob([readFileSync(wavPath)], { type: 'audio/wav' }), 'audio.wav')
    const res = await fetch(base + '/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key },
      body,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error('cloud STT: HTTP ' + res.status + ' ' + text.slice(0, 200))
    }
    const json = await res.json()
    return (json && json.text) || ''
  }
  throw lastError || new Error('cloud STT: no resolvable provider')
}
