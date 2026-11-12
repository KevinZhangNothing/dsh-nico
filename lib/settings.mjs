// Nico's two model selections. Current DSH serves editable plugin settings from
// the exported Config schema (lib/config.mjs) and settings.update(); older code
// called settings.register(), which current hosts do not provide. Keep the file
// fallback for the bare CLI and migrate its existing values into the GUI entry.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NICO_DIR } from './paths.mjs'

export const NICO_SETTINGS_SHAPE = {
  reasoning: { provider: null, model: null },
  greeting: '',
  stt: { engine: 'local', model: null, cloudProvider: null },
  tts: { engine: 'say', url: null, model: null, voice: null, instruct: null, speed: null, install: null },
}

const NAMESPACE = 'dsh-nico'
const clone = (v) => JSON.parse(JSON.stringify(v))
// Volatile Config leaves arrive as references in the host; GUI/CLI callers use
// plain values. Normalize both at the boundary.
const unwrap = (v) => v && typeof v.get === 'function' ? v.get() : v

function merge(base, patch) {
  const out = clone(base)
  for (const key of ['reasoning', 'stt', 'tts']) {
    if (patch && typeof patch === 'object' && patch[key]) {
      out[key] = { ...out[key], ...clone(patch[key]) }
    }
  }
  return out
}

function readStored(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {} } catch { return {} }
}

// The host schema uses empty strings for absent values; the voice flow uses
// null internally so existing reasoningRoute()/sttSelection() behavior stays put.
function hostShape(value) {
  return {
    greeting: value.greeting || '',
    reasoning: {
      provider: value.reasoning?.provider || '',
      model: value.reasoning?.model || '',
    },
    stt: {
      engine: value.stt?.engine || 'local',
      model: value.stt?.model || '',
      cloudProvider: value.stt?.cloudProvider || '',
    },
    tts: {
      engine: value.tts?.engine || 'say',
      url: value.tts?.url || '',
      model: value.tts?.model || '',
      voice: value.tts?.voice || '',
      instruct: value.tts?.instruct || '',
      speed: value.tts?.speed || 1,
      install: value.tts?.install || '',
    },
  }
}

export class NicoSettings {
  constructor(ctx, config = {}) {
    this.namespace = NAMESPACE
    // Raw Config kept for LIVE leaf reads: volatile leaves arrive as references
    // that the host updates in place when the settings GUI commits, so reading
    // them per call makes voice/instruct/model changes effective without
    // restarting the host (this.base only captures construction-time values).
    this._config = config || {}
    this._file = join(NICO_DIR, 'settings.json')
    const stored = readStored(this._file)
    const configured = {
      greeting: unwrap(config.greeting) || '',
      reasoning: { provider: unwrap(config.reasoning?.provider), model: unwrap(config.reasoning?.model) },
      stt: { engine: unwrap(config.stt?.engine), model: unwrap(config.stt?.model), cloudProvider: unwrap(config.stt?.cloudProvider) || '' },
      tts: {
        engine: unwrap(config.tts?.engine), url: unwrap(config.tts?.url), model: unwrap(config.tts?.model),
        voice: unwrap(config.tts?.voice), instruct: unwrap(config.tts?.instruct), speed: unwrap(config.tts?.speed),
        install: unwrap(config.tts?.install),
      },
    }
    this.base = {
      greeting: configured.greeting || stored.greeting || '',
      reasoning: {
        provider: configured.reasoning.provider || stored.reasoning?.provider || null,
        model: configured.reasoning.model || stored.reasoning?.model || null,
      },
      stt: {
        engine: configured.stt.engine || stored.stt?.engine || 'local',
        model: configured.stt.model || stored.stt?.model || null,
        cloudProvider: configured.stt.cloudProvider || stored.stt?.cloudProvider || null,
      },
      tts: {
        engine: configured.tts.engine || stored.tts?.engine || 'say',
        url: configured.tts.url || stored.tts?.url || null,
        model: configured.tts.model || stored.tts?.model || null,
        voice: configured.tts.voice || stored.tts?.voice || null,
        instruct: configured.tts.instruct || stored.tts?.instruct || null,
        speed: configured.tts.speed || stored.tts?.speed || null,
        install: configured.tts.install || stored.tts?.install || '',
      },
    }
    this._persist = async () => false
    this._register(ctx, configured, stored)
  }

  _register(ctx, config, stored) {
    const settings = ctx?.get?.('settings')
    if (settings && typeof settings.update === 'function') {
      this._persist = async (patch) => {
        await settings.update(this.namespace, hostShape(merge(this.base, patch)))
        return true
      }
      // One-time adoption of the pre-GUI file selection. Subsequent starts see
      // non-empty Config values and do not write anything.
      const patch = {}
      if (!config.greeting && stored.greeting) patch.greeting = stored.greeting
      if (!config.reasoning?.provider && !config.reasoning?.model && stored.reasoning?.provider && stored.reasoning?.model) {
        patch.reasoning = stored.reasoning
      }
      if (!config.stt?.engine && stored.stt?.engine) patch.stt = stored.stt
      if (!config.tts?.engine && stored.tts?.engine) patch.tts = stored.tts
      if (Object.keys(patch).length) {
        void this._persist(patch).catch((e) => {
          ctx?.logger?.warn?.('dsh-nico: failed to migrate saved model selection: %s', e?.message || e)
        })
      }
      return
    }
    this._persist = async (patch) => {
      try {
        this.base = merge(this.base, patch)
        mkdirSync(NICO_DIR, { recursive: true })
        writeFileSync(this._file, JSON.stringify(this.base, null, 2) + '\n')
        return true
      } catch { return false }
    }
  }

  get() { return clone(this.base) }

  // Live volatile leaf: { present: true, value } when the Config leaf exists
  // (even if '' — an explicit clear must win over the stale base), else absent
  // and callers fall back to base. Path is section(s) + key.
  _live(...path) {
    try {
      let node = this._config
      for (const key of path) {
        if (node == null) return { present: false, value: null }
        node = node[key]
      }
      const v = unwrap(node)
      return v === undefined || v === null ? { present: false, value: null } : { present: true, value: v }
    } catch { return { present: false, value: null } }
  }

  async set(patch) {
    const durable = await this._persist(patch)
    this.base = merge(this.base, patch)
    return { durable, selection: this.get() }
  }

  greeting() {
    const live = this._live('greeting')
    if (live.present) return live.value || ''
    return this.get().greeting || ''
  }

  reasoningRoute() {
    const lp = this._live('reasoning', 'provider')
    const lm = this._live('reasoning', 'model')
    const provider = lp.present ? lp.value : (this.base.reasoning?.provider ?? null)
    const model = lm.present ? lm.value : (this.base.reasoning?.model ?? null)
    if (provider || model) return { provider: provider ?? null, model: model ?? null }
    return null
  }

  sttSelection() {
    const le = this._live('stt', 'engine')
    const lv = this._live('stt', 'model')
    const lc = this._live('stt', 'cloudProvider')
    const b = this.get().stt || {}
    const engine = (le.present ? le.value : b.engine) === 'cloud' ? 'cloud' : 'local'
    return {
      engine,
      model: (lv.present ? lv.value : b.model) || null,
      cloudProvider: (lc.present ? lc.value : b.cloudProvider) || null,
    }
  }

  ttsSelection() {
    const le = this._live('tts', 'engine')
    const engine = (le.present ? le.value : this.get().tts?.engine)
    if (engine !== 'cosyvoice') return { engine: 'say' }
    const b = this.get().tts || {}
    const pick = (key) => {
      const live = this._live('tts', key)
      // present but empty means the user explicitly cleared it — that wins.
      return live.present ? (live.value || null) : (b[key] || null)
    }
    return {
      engine: 'cosyvoice',
      url: pick('url'), model: pick('model'), voice: pick('voice'),
      instruct: pick('instruct'), speed: pick('speed'),
    }
  }
}
