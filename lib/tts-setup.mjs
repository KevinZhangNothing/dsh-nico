// CosyVoice2 lifecycle for the GUI deploy card.
//   deployCosyVoice() → spawns scripts/setup-cosyvoice.mjs DETACHED (clone +
//                        venv + requirements + ModelScope weights + server
//                        launch); progress streams to deploy-status.json and
//                        deploy.log on disk. Never blocks, never touches the
//                        settings service — runtime configEditor writes have a
//                        fatal compose check that took the host down once.
//   startCosyVoice()  → if not deployed, chains the detached deploy (which
//                        launches the server at the end); if installed but
//                        down, launches the server directly.
//   stopCosyVoice()   → SIGTERM the pid-file process.
// Liveness is observed by the GUI through HTTP probes of the service itself.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const COSY_DIR = join(homedir(), '.dsh', 'nico', 'cosyvoice')
export const COSY_SRC = join(COSY_DIR, 'src')
export const COSY_VENV = join(COSY_DIR, 'venv')
export const COSY_MODEL = join(COSY_DIR, 'models', 'CosyVoice2-0.5B')
export const COSY_PID = join(COSY_DIR, 'server.pid')
export const COSY_STATUS = join(COSY_DIR, 'deploy-status.json')
export const COSY_DEPLOY_LOG = join(COSY_DIR, 'deploy.log')
const SERVER_PY = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cosyvoice_server.py')
const SETUP_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'setup-cosyvoice.mjs')

export function pythonBin() { return join(COSY_VENV, 'bin', 'python') }

export function cosyvoiceInstalled() {
  return existsSync(COSY_MODEL) && existsSync(join(COSY_MODEL, 'cosyvoice2.yaml')) && existsSync(pythonBin())
}

/** Probe {url}/models with a short timeout. */
export async function cosyvoiceUp(url, timeoutMs = 2500) {
  try {
    const res = await fetch(String(url || '').replace(/\/+$/, '') + '/models', { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch { return false }
}

function noteStatus(state, detail, pid) {
  try {
    mkdirSafe(COSY_DIR)
    writeFileSync(COSY_STATUS, JSON.stringify({ state, detail, pid, at: new Date().toISOString() }, null, 2) + '\n')
    if (detail) appendFileSync(COSY_DEPLOY_LOG, new Date().toISOString() + ' ' + detail + '\n')
  } catch {}
}

function mkdirSafe(dir) { try { mkdirSync(dir, { recursive: true }) } catch {} }

/** Fire-and-forget the full deploy+start chain as a detached child. */
export function deployCosyVoice(url) {
  mkdirSafe(COSY_DIR)
  if (deployRunning()) return { started: false, reason: '部署已在进行中' }
  try { appendFileSync(COSY_DEPLOY_LOG, '\n---- deploy requested ' + new Date().toISOString() + ' ----\n') } catch {}
  const child = spawn(process.execPath, [SETUP_JS, '--serve', portOf(url)], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, COSY_DIR, COSY_STATUS, COSY_LOG_FILE: COSY_DEPLOY_LOG, NICO_SERVER_PY: SERVER_PY },
  })
  child.unref()
  noteStatus('running', 'detached deploy pid=' + child.pid, child.pid)
  return { started: true, pid: child.pid }
}

/** A deploy child owns COSY_DIR while a fresh status file says running. */
export function deployRunning() {
  try {
    const s = JSON.parse(readFileSync(COSY_STATUS, 'utf8'))
    if (s.state !== 'running') return false
    if (Date.now() - Date.parse(s.at) > 60 * 60 * 1000) return false
    if (s.pid) { try { process.kill(s.pid, 0) } catch { return false } }   // pid dead → stale
    return true
  } catch { return false }
}

/** Ensure the service is up: already up → noop; else chain the detached deploy. */
export async function startCosyVoice(url) {
  if (await cosyvoiceUp(url)) return { ok: true, reason: '服务已在运行' }
  if (!cosyvoiceInstalled() && deployRunning()) return { ok: false, reason: '部署进行中，等它完成即可' }
  const r = deployCosyVoice(url)
  return { ok: r.started, reason: r.started ? '部署已启动（10–20 分钟），日志 ' + COSY_DEPLOY_LOG : r.reason }
}

/** Stop the server via its pid file (the server owns its pid file). */
export async function stopCosyVoice() {
  try {
    const pid = parseInt(readFileSync(COSY_PID, 'utf8'), 10)
    process.kill(pid, 'SIGTERM')
    return { ok: true, reason: '已停止 pid=' + pid }
  } catch (e) {
    return { ok: false, reason: '没有运行中的服务（' + (e?.code || e?.message || e) + '）' }
  }
}

function portOf(url) {
  try { return new URL(url).port || '59993' } catch { return '59993' }
}
