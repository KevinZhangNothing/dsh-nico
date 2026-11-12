// dsh headless session glue: ensure a fixed session, send a command, capture the reply.
// The selected reasoning model (from nico settings) is applied as a generated
// --patch overlay — the headless CLI has no --provider/--model flag, so the model
// comes from the profile's agent-default-model, exactly like the jira-poll patch.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SESSION_ID_FILE, SESSION_CWD_FILE, NICO_DIR, GREETING_FILE } from './paths.mjs'
import { resolveProviderEndpoint } from './models.mjs'
import { loadApiKey } from './apikey.mjs'

const DSH = 'dsh'
const PATCH_FILE = join(NICO_DIR, 'model.patch.yml')
let settingsRef = null

// Session bootstrap message. Sent once when the fixed headless session is
// first created, to teach the session how to treat each subsequent voice
// command. Overridable from the settings GUI (NicoSettings → dsh.mjs via
// setGreeting; the GUI writes the greeting through the volatile Config leaf
// 'greeting'). Empty → built-in default.
//
// Every reply is read aloud by TTS, so the contract pins the reply SHAPE, not
// just the task-execution mode: without it the session reads back whole task
// results (paths, lists, diffs) and the spoken answer runs for minutes. The
// GUI field only carries ADDITIONAL guidance — the contract is always
// prepended, user text never replaces it.
const CONTRACT =
  '你好，我是你的语音助手 Nico。之后我说的每句话请当作独立任务执行。' +
  '你的全部回复都会被转成语音朗读，因此必须遵守：' +
  '只说结论和关键结果，不超过两句话；' +
  '禁止朗读或复述任务输出、文件路径、代码、链接和列表，用平实的口语短句。'
const DEFAULT_GREETING = CONTRACT + '现在只回复两个字：收到'

export function setSettings(s) { settingsRef = s || null }

function env() {
  const key = loadApiKey()
  const e = { ...process.env }
  if (key) e.DEEPSEEK_API_KEY = key
  const nothingKey = readCredentialRef('NOTHING_LLM_API_KEY') || readCredentialRef('DSH_LARK_NOTHING_LLM_API_KEY')
  if (nothingKey) e.DSH_LARK_NOTHING_LLM_API_KEY = nothingKey
  e.PATH = '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:' + (e.PATH || '')
  return e
}

function readCredentialRef(name) {
  const f = join(homedir(), '.dsh', '.credentials.yaml')
  if (!existsSync(f)) return null
  try {
    const lines = readFileSync(f, 'utf8').split('\n')
    let inRefs = false
    for (const ln of lines) {
      if (/^refs:/.test(ln)) { inRefs = true; continue }
      if (inRefs && ln.trim() !== '' && !/^\s/.test(ln)) break
      if (inRefs) {
        const m = ln.match(new RegExp('^\\s{2}' + name + ':\\s*(\\S.*)\\s*$'))
        if (m) return m[1]
      }
    }
  } catch {}
  return null
}

function sessionCwd() {
  if (existsSync(SESSION_CWD_FILE)) {
    const c = readFileSync(SESSION_CWD_FILE, 'utf8').trim()
    if (c) return c
  }
  return process.env.NICO_SESSION_CWD || homedir()
}

function selectedRoute() {
  try { return settingsRef?.reasoningRoute?.() ?? null } catch { return null }
}

function readGreetingFile() {
  try { return existsSync(GREETING_FILE) ? readFileSync(GREETING_FILE, 'utf8').trim() : '' } catch { return '' }
}

export function setGreeting(g) { greetingOverride = typeof g === 'string' ? g : null }
let greetingOverride = null

// The host `llm` service, injected by the cordis entrypoint (lib/index.js) at
// startup. resolveProviderEndpoint() reads the host's OWN model config for a
// selected provider, so the generated patch never hardcodes an endpoint.
let llmService = null
let hostSettings = null
export function setLlmService(s, settings = null) { llmService = s || null; hostSettings = settings }

export function greeting() {
  const fromSettings = (() => { try { return settingsRef?.greeting?.() || '' } catch { return '' } })()
  const user = fromSettings || greetingOverride
  // Prepend the contract to any user text: a greeting-only custom line once
  // made the session answer 7 consecutive 「你好，有什么可以帮你？」 turns for
  // unrelated commands. GREETING_FILE is deliberately NOT fed back as user
  // text — it stores the full greeting that was sent (contract included), so
  // re-reading it here would double the contract on every session recreation
  // and permanently bake in an outdated default.
  if (user) return CONTRACT + user
  return DEFAULT_GREETING
}

let pendingEndpoint = null
function endpointFromSettings(provider) {
  try {
    const rows = hostSettings?.describe?.() || []
    const form = rows.find((row) => row.ns === 'llm-pi-ai')
    const config = form?.value?.providers?.[provider]
    if (!config) return null
    const baseUrl = config.baseURL || config.baseUrl || null
    const apiKeyEnv = config.apiKeyEnv || null
    return baseUrl || apiKeyEnv ? { baseUrl, apiKeyEnv, source: 'settings' } : null
  } catch { return null }
}

export async function prepareRoute(route) {
  const provider = (route || {}).provider
  if (!provider) return null
  const ep = await resolveProviderEndpoint(llmService, provider) || endpointFromSettings(provider)
  pendingEndpoint = ep
  return ep
}

function renderPatch(route, endpoint) {
  if (!route || (!route.provider && !route.model)) return null
  const provider = route.provider || 'nothing-llm'
  const model = route.model
  const L = []
  L.push('# nico-generated reasoning-model overlay; do not hand-edit.')
  L.push('- id: agent-default-model')
  L.push('  name: "@deepseek-ai/dsh-agent-default-model"')
  L.push('  config:')
  L.push('    provider: ' + provider)
  L.push('    model: ' + model)
  // Endpoint comes from the host's own model config for this provider
  // (resolveProviderEndpoint). When the host exposes no config for the
  // provider, the host already knows it — no provider block is emitted and the
  // session simply uses the host's existing definition.
  if (endpoint && (endpoint.baseUrl || endpoint.apiKeyEnv)) {
    L.push('- id: llm-pi-ai')
    L.push('  name: "@deepseek-ai/dsh-llm-pi-ai"')
    L.push('  config:')
    L.push('    providers:')
    L.push('      ' + provider + ':')
    if (endpoint.baseUrl) L.push('        baseURL: ' + endpoint.baseUrl)
    if (endpoint.apiKeyEnv) L.push('        apiKeyEnv: ' + endpoint.apiKeyEnv)
    L.push('        api: openai-completions')
    L.push('        models:')
    L.push('          - id: ' + model)
    L.push('            name: ' + model)
  }
  return L.join('\n') + '\n'
}

function patchArgs() {
  const route = selectedRoute()
  const body = renderPatch(route, pendingEndpoint)
  if (body === null) {
    try { if (existsSync(PATCH_FILE)) writeFileSync(PATCH_FILE, '') } catch {}
    return []
  }
  mkdirSync(NICO_DIR, { recursive: true })
  try {
    const cur = existsSync(PATCH_FILE) ? readFileSync(PATCH_FILE, 'utf8') : null
    if (cur !== body) writeFileSync(PATCH_FILE, body)
  } catch {}
  return ['--patch', PATCH_FILE]
}

export function ensureSession() {
  const sid = existsSync(SESSION_ID_FILE) ? readFileSync(SESSION_ID_FILE, 'utf8').trim() : ''
  const g = greeting()
  if (sid && readGreetingFile() === g) return sid
  if (sid) {
    // The bootstrap contract changed (built-in default upgraded, or the GUI
    // greeting edited). The fixed session only hears its greeting once, so
    // rotate to a fresh session instead of leaving the old contract in force —
    // previously this required deleting ~/.dsh/nico/session_id by hand.
    try { unlinkSync(SESSION_ID_FILE) } catch {}
  }
  const cwd = process.env.NICO_SESSION_CWD || homedir()
  try { mkdirSync(NICO_DIR, { recursive: true }); writeFileSync(GREETING_FILE, g + '\n', { mode: 0o600 }) } catch {}
  // Create the session with the selected route from the first turn. Otherwise
  // the next command has to compact/switch an existing session's model first.
  const res = spawnSync(DSH, [...patchArgs(), '--profile', 'headless', '--json', g], { encoding: 'utf8', env: env(), timeout: 120000, cwd })
  const out = (res.stdout || '').trim()
  const m = out.match(/"sessionId"\s*:\s*"([^"]+)"/)
  if (!m) throw new Error('nico: 无法创建会话: ' + out.slice(-300))
  const newSid = m[1]
  mkdirSync(NICO_DIR, { recursive: true })
  writeFileSync(SESSION_ID_FILE, newSid, { mode: 0o600 })
  writeFileSync(SESSION_CWD_FILE, cwd, { mode: 0o600 })
  return newSid
}

function parseFinal(stdout) {
  const lines = (stdout || '').split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i])
      if (o && o.type === 'final' && o.reason?.kind === 'error') {
        return { ok: false, text: o.reason.error?.message || o.text || '执行出错', reason: o.reason }
      }
      if (o && o.type === 'final') return { ok: true, text: o.text || '', reason: o.reason }
      if (o && o.type === 'error') return { ok: false, text: o.message || '执行出错', reason: o.reason }
    } catch {}
  }
  const raw = (stdout || '').trim()
  return raw ? { ok: true, text: raw } : { ok: false, text: '（没有回复）' }
}

export async function runCommand(text, { timeoutMs = 300000, approval = 'never' } = {}) {
  // Spoken new-session phrase: rotate without bothering the old session.
  if (isNewSessionCommand(text)) {
    resetSession()
    return { ok: true, reply: '好的，已开启新会话。' }
  }
  const cwd = sessionCwd()
  try { await prepareRoute(selectedRoute()) } catch { pendingEndpoint = null }
  for (let attempt = 0; attempt < 2; attempt++) {
    let sid
    try { sid = ensureSession() } catch (e) { return { ok: false, reply: '执行失败：' + (e?.message || e) } }
    // --patch is a launcher flag: it must precede --profile, not sit in the app-args.
    const args = [...patchArgs(), '--profile', 'headless', '--json', '--session-id', sid, '--approval-policy', approval, text]
    const res = spawnSync(DSH, args, { encoding: 'utf8', env: env(), timeout: timeoutMs, cwd })
    if (res.error) return { ok: false, reply: '执行失败：' + res.error.message, sid }
    const parsed = parseFinal(res.stdout || '')
    // The fixed headless session can be adopted by another DSH consumer (e.g. the
    // desktop host resuming it in the GUI), which holds the write lock. Rotate to
    // a fresh session and retry once instead of failing every voice command.
    const modelSwitchFailed = parsed.reason?.error?.code === 'MODEL_SWITCH_COMPACTION_FAILED' ||
      /Cannot switch to|no adapter registered for provider/.test(parsed.text || '')
    const stale = !parsed.ok && (((parsed.text || '').includes(sid) &&
      /is already owned by an active write handle|not found/.test(parsed.text || '')) || modelSwitchFailed)
    if (stale && attempt === 0) {
      try { unlinkSync(SESSION_ID_FILE) } catch {}
      continue
    }
    return { ok: parsed.ok, reply: parsed.text, reason: parsed.reason, sid }
  }
}

// Voice-triggered session rotation: every command otherwise lands in the one
// fixed session and context piles up forever. Saying a new-session phrase
// drops the session id; the NEXT command lazily creates a fresh session with
// the greeting. The old session stays in the DSH session list for inspection.
const NEW_SESSION_RE = /新(的)?(会话|对话)|新开.{0,8}(会话|对话)|重(新)?开.{0,8}(会话|对话)|清空(会话|对话|上下文)|newsession/i
export function isNewSessionCommand(text) {
  const t = String(text || '').replace(/[\s，。！？!?,.、']/g, '')
  return NEW_SESSION_RE.test(t)
}

export function resetSession() {
  try { if (existsSync(SESSION_ID_FILE)) unlinkSync(SESSION_ID_FILE) } catch {}
}

export function getSid() {
  if (existsSync(SESSION_ID_FILE)) {
    const s = readFileSync(SESSION_ID_FILE, 'utf8').trim()
    if (s) return s
  }
  return ensureSession()
}
