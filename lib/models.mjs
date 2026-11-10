// Model catalogs for nico's two selections.
//
//   reasoning: every route the host `llm` registry advertises (nothing-llm,
//              kimi-coding, minimax-cn, ...), flattened — the same advisory
//              catalog dsh-lark-channel's /model reads. Plus the current
//              deployment default from the `agentDefaultModel` service.
//   stt:       the built-in local SenseVoiceSmall INT8 (on disk) plus any
//              cloud ASR model the catalog lists (nothing-llm's qwen3-asr).
//
// Both degrade to empty/known-only when a service or file is absent, so the
// caller can still offer the local STT and a manual provider/model form.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MODEL_DIR } from './paths.mjs'

const LOCAL_STT_ID = 'sensevoice-small-int8'

/**
 * @param ctx - host plugin context (null in bare CLI → empty reasoning catalog).
 * @returns { reasoning: { catalog: Route[], default: Route|null }, stt: { local: bool, cloud: Route[] } }
 */
export async function modelCatalogs(ctx) {
  const catalog = []
  let def = null
  const llm = ctx?.get?.('llm')
  if (llm && typeof llm.listProviders === 'function') {
    try {
      const providers = await llm.listProviders()
      const results = await Promise.all(providers.map(async (p) => {
        try { return await llm.listModels(p.id) } catch { return [] }
      }))
      for (const models of results) {
        for (const m of models) {
          catalog.push({ provider: m.provider, id: m.id, name: m.name ?? m.id })
        }
      }
    } catch { /* advisory: keep whatever we gathered */ }
  }
  const adm = ctx?.get?.('agentDefaultModel')
  if (adm && typeof adm.currentSelection === 'function') {
    try { def = adm.currentSelection() ?? null } catch { def = null }
  }
  const stt = sttCatalog(catalog)
  return { reasoning: { catalog, default: def }, stt }
}

/** Local STT is available when the SenseVoice ONNX int8 model + tokens are on disk. */
export function localSttAvailable() {
  return existsSync(join(MODEL_DIR, 'model.int8.onnx')) && existsSync(join(MODEL_DIR, 'tokens.txt'))
}

/**
 * Partition the catalog into ASR-capable entries. We can't introspect a
 * model's modalities from the advisory catalog, so we match by well-known ASR
 * markers in the id/name and let the caller treat the rest as reasoning-only.
 * @param catalog - the flattened reasoning catalog.
 * @returns cloud ASR routes.
 */
function sttCatalog(catalog) {
  const cloud = catalog.filter((m) => {
    const hay = (m.id + ' ' + (m.name || '')).toLowerCase()
    return hay.includes('asr') || hay.includes('speech') || hay.includes('sensevoice')
  })
  return { local: localSttAvailable(), cloud }
}

/**
 * Resolve a typed reasoning route against the catalog. A full provider/model
 * is taken as written; a bare id resolves when exactly one route carries it
 * (same shorthand dsh-lark-channel's /model uses).
 * @returns { route?: {provider,model}, listed?: boolean } | { reason: string }
 */
export function resolveReasoningRoute(input, catalog) {
  const value = String(input || '').trim()
  if (!value) return { reason: '用法：/model use <provider/model 或模型名>' }
  if (value.includes('/')) {
    const i = value.indexOf('/')
    const provider = value.slice(0, i)
    const model = value.slice(i + 1)
    if (!provider || !model) return { reason: value + ' 不是合法的 provider/model 形式。' }
    return { route: { provider, model }, listed: catalog.some((m) => m.provider === provider && m.id === model) }
  }
  const matches = catalog.filter((m) => m.id === value)
  if (matches.length === 1) return { route: { provider: matches[0].provider, model: matches[0].id }, listed: true }
  if (matches.length > 1) {
    const list = matches.map((m) => m.provider + '/' + m.id).join('\n')
    return { reason: '模型 ' + value + ' 属于多个 provider：\n' + list + '\n请用完整的 provider/model。' }
  }
  return { reason: catalog.length === 0
    ? '本部署没有可枚举的模型目录，用完整 provider/model 直接设置。'
    : '目录里没有 ' + value + '，用完整 provider/model 试试。' }
}

/**
 * Auto-resolve the OpenAI-compatible endpoint for a reasoning provider from the
 * host's own model config (llm service → provider entry). Nothing is hardcoded:
 * the baseURL / apiKeyEnv are whatever the host has configured for that provider.
 * @param llm - the host `llm` service (ctx.get('llm')), may be null
 * @param provider - provider id from the catalog
 * @returns { baseUrl, apiKeyEnv, source } | null when the host exposes no config
 */
export async function resolveProviderEndpoint(llm, provider) {
  if (!llm || !provider) return null
  try {
    const entry = typeof llm.getProvider === 'function' ? await llm.getProvider(provider) : null
    if (entry && typeof entry === 'object') {
      const baseUrl = entry.baseUrl || entry.baseURL || null
      const apiKeyEnv = entry.apiKeyEnv || entry.apiKeyEnvVar || null
      if (baseUrl || apiKeyEnv) return { baseUrl, apiKeyEnv, source: entry.source || 'llm' }
    }
  } catch { /* fall through to listProviders */ }
  try {
    const providers = await llm.listProviders()
    const entry = providers.find((p) => p && (p.id === provider || p.name === provider))
    if (entry) {
      const baseUrl = entry.baseUrl || entry.baseURL || null
      const apiKeyEnv = entry.apiKeyEnv || entry.apiKeyEnvVar || null
      if (baseUrl || apiKeyEnv) return { baseUrl, apiKeyEnv, source: 'listProviders' }
    }
  } catch { /* advisory: keep null */ }
  return null
}
