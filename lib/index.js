/**
 * dsh-nico — 按住右⌘说一句 → 本地 AI 替我操作电脑。
 *
 * Cordis plugin bundle for DSH. Two faces:
 *
 *   1. PARASITE (default, this file): when a DSH profile lists this bundle in
 *      `dsh.profile.bundles`, `apply(ctx)` installs the right-⌘ CGEventTap IN the
 *      host process. The hold-to-talk loop is exactly the one the CLI uses
 *      (lib/voice.mjs). Host process lifetime = tap lifetime: the `ctx.effect`
 *      cleanup tears the tap down on profile teardown. TCC Input Monitoring is
 *      attributed to the responsible host (com.deepseek.dsh for desktop/lark/web).
 *
 *   2. CLI runtime: re-exports so a host or `bin/nico.js` can drive it directly
 *      (transcribeFile / runCommand / startRecording / Hotkey / startNicoVoice).
 *
 * Model selection (reasoning + speech) is stored in a nico settings section in
 * the host `settings` service (lib/settings.mjs) and applied:
 *   - reasoning → a generated --patch overlay on the headless session (dsh.mjs)
 *   - speech    → lib/stt.mjs routes local SenseVoice vs cloud ASR
 * The catalogs (which models exist) come from the host llm registry (models.mjs).
 *
 * Cordis contract (matches @deepseek-ai/cordis + the working memory-hooks plugin):
 *   - export `name`
 *   - export `apply(ctx)` returning a cleanup function
 *   - use `ctx.on(event, cb)` / `ctx.get(service)`; NO `inject` export
 *   - export Config with volatile leaves for the host settings GUI
 *   - the package's ./client export contributes the Nico settings tab
 *
 * Configuration: optional `config` second arg. Honored keys:
 *   - autoStart  (default true)   start the hotkey tap on apply
 *   - maxSec     (default 30)     mic recording cap per hold
 *   - speak      (default true)   route replies through macOS `say`
 *   - bubble     (default true)   show the on-screen recording bubble
 *   - reasoning  { provider, model }  seed the reasoning route
 *   - stt        { engine, model }    seed the speech model
 */
import { spawnSync, spawn } from 'node:child_process'
import { eventToState, decorate } from './overlay-proto.mjs'
import { RT_DIR } from './paths.mjs'
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, appendFileSync as _nicoAppend } from 'node:fs'
const appendFileSyncLazy = () => _nicoAppend
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const log = (...a) => console.error('[dsh-nico]', ...a)

// File-based diagnostic (readable even when the desktop host swallows console.error).
// Append each apply()/start() gate to ~/.dsh/nico/apply.log so we can see where the
// flow stops without a terminal.
const DIAG_FILE = join(process.env.HOME || '~', '.dsh', 'nico', 'apply.log');
function diag(tag) {
  try {
    mkdirSync(dirname(DIAG_FILE), { recursive: true });
    const ts = new Date().toISOString();
    require_fs_append(DIAG_FILE, ts + ' [dsh-nico] ' + tag + '\n', { encoding: 'utf8' });
  } catch {}
}
const require_fs_append = (...a) => { try { const f = appendFileSyncLazy(); f(...a) } catch {} };


// ── 录音气泡 ─────────────────────────────────────────────────────────────
// 一个无边框、不抢焦点的 Swift NSPanel（编译产物 native/bubble），寄生进程
// spawn 出来、经 stdin 逐行 JSON 驱动：show 显示/换字、close 隐藏并退出。
// 它合成成真正的 WindowServer 窗口（CGWindowList 实测非零边界、isOnscreen），
// 且 accessory NSPanel 无需任何 TCC 授权、不抢宿主焦点。
const BUBBLE_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'bubble.swift')
const SPRITE_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sprite')
const rtRoot = process.env.NICO_RT_ROOT || RT_DIR

function compileBubble() {
  const out = join(rtRoot, 'bubble')
  try {
    // 二进制比源码旧 → 重新编译（否则 bubble.swift 的改动永远不会生效——
    // 部署产物 rt/bubble 一旦存在就终身复用）。
    if (existsSync(out) && statSync(out).mtimeMs >= statSync(BUBBLE_SRC).mtimeMs) return out
    mkdirSync(rtRoot, { recursive: true })
    const r = spawnSync('swiftc', ['-O', BUBBLE_SRC, '-o', out], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error('swiftc: ' + (r.stderr || '').trim().slice(0, 200))
    diag('bubble:compiled ' + out)
    return out
  } catch (e) {
    diag('bubble:compile failed ' + (e.message || e))
    log('气泡编译失败：' + (e.message || e))
    return null
  }
}

// 鲸鱼娘表情立绘（assets/sprite/表情_*.png）部署到 rt 根：Swift 气泡运行时
// 从 NICO_SPRITE_DIR 读取。文件缺失或大小不一致才复制，已存在则跳过。
function deploySprites() {
  const dir = join(rtRoot, 'sprite')
  try {
    mkdirSync(dir, { recursive: true })
    for (const f of readdirSync(SPRITE_SRC)) {
      if (!f.endsWith('.png')) continue
      const src = join(SPRITE_SRC, f)
      const dst = join(dir, f)
      if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) copyFileSync(src, dst)
    }
    return dir
  } catch (e) { diag('sprite:deploy failed ' + (e.message || e)); return null }
}

let bubbleProc = null
// overlay 宿主 stdout 事件（目前只有人物窗「新会话」按钮）：由 start() 注册。
let bubbleEventHandler = null
function bubbleSend(obj) {
  if (!bubbleProc || bubbleProc.killed) return
  try { bubbleProc.stdin?.write(JSON.stringify(obj) + '\n') } catch {}
}
function bubbleEnsure() {
  if (bubbleProc) return
  const spriteDir = deploySprites()
  const bin = compileBubble()
  if (!bin) return
  try {
    bubbleProc = spawn(bin, {
      // stdout 是 overlay → 插件的事件通道（按钮点击等），必须接管。
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, NICO_RT: rtRoot, ...(spriteDir ? { NICO_SPRITE_DIR: spriteDir } : {}) },
    })
    {
      let sbuf = ''
      bubbleProc.stdout?.on('data', (d) => {
        sbuf += d
        let i
        while ((i = sbuf.indexOf('\n')) >= 0) {
          const line = sbuf.slice(0, i)
          sbuf = sbuf.slice(i + 1)
          try { bubbleEventHandler?.(JSON.parse(line)) } catch {}
        }
      })
    }
    bubbleProc.on('error', (e) => { diag('bubble:spawn error ' + (e?.message || e)); bubbleProc = null })
    bubbleProc.on('exit', (code, signal) => { diag('bubble:exit code=' + code + ' signal=' + signal); bubbleProc = null })
  } catch (e) { diag('bubble:spawn failed ' + (e?.message || e)); log('气泡启动失败：' + (e.message || e)); bubbleProc = null }
}

// voice 事件 → 新 stdin 状态协议（eventToState/decorate 见 overlay-proto.mjs）
let lastReply = ''
function pushState(event, payload) {
  if (!bubbleEnabled) return
  bubbleEnsure()
  const s = decorate(eventToState(event, payload))
  if (s) bubbleSend({ op: 'state', ...s })
}
function bubbleClose() {
  bubbleSend({ op: 'close' })
  try { bubbleProc?.stdin?.end() } catch {}
  bubbleProc = null
}
let bubbleEnabled = true

// Re-export the runtime surface so a host / CLI can import the bundle and use it.
export { recognizeWav, transcribe, setSttSelection } from './stt.mjs'
export { runCommand, ensureSession, getSid, setSettings } from './dsh.mjs'
export { startRecording } from './recorder.mjs'
export { Hotkey, checkAccessibility } from './hotkey.mjs'
export { NicoVoice, startNicoVoice } from './voice.mjs'
export { modelCatalogs, resolveReasoningRoute, localSttAvailable } from './models.mjs'
export { NicoSettings } from './settings.mjs'
export { default as Config } from './config.mjs'
export { NICO_DIR, MODEL_DIR, RT_DIR } from './paths.mjs'

export const name = 'dsh-nico'

// Reply speech is routed through lib/tts.mjs (macOS say or a local CosyVoice2
// deployment per the nico settings tts section). speakText never throws.

// Human label for the current reasoning route, e.g. "nothing-llm / Qwen3.8 27B".
function routeLabel(settings, catalog) {
  const route = settings.reasoningRoute()
  if (!route) {
    const c = catalog.find((m) => m.provider === (routeDefault?.provider) && m.id === routeDefault?.model)
    return c ? c.provider + ' / ' + c.name : (routeDefault ? routeDefault.provider + '/' + routeDefault.model : '宿主默认')
  }
  const c = catalog.find((m) => m.provider === route.provider && m.id === route.model)
  return c ? c.provider + ' / ' + c.name : (route.provider || '') + '/' + route.model
}
let routeDefault = null

// Cordis entrypoint. Installs the right-⌘ hold-to-talk tap in the host process and
// returns a cleanup function (tears the tap down). Modeled on dsh-lark-channel:
// a ctx.effect registers lifetime, an async bootstrap waits for the host to settle
// (loader await) before going live so we never race the composition.
// ── Re-apply de-dup ──────────────────────────────────────────────────────
// Any nico settings write (the GUI commits leaves during the voice flow
// itself) makes the host re-apply() this plugin. A blind rebuild spawns a
// second hotkey tap + NicoVoice while the first instance may still be
// mid-runCommand — two taps, overlapping afplay speech (observed: apply:ENTRY
// ~0.4s after every voice:transcript, hotkey:exit between cycles). The
// in-process host tears the previous instance down with the cleanup function
// it returned, so the module-level `live` slot is authoritative:
//   apply()  → skip if `live` is still up (re-apply of an already-live tap)
//   cleanup  → voice.stop() + live=null (real teardown; next apply rebuilds)
let live = null

export function apply(ctx, config = {}) {
  diag('apply:ENTRY ctx=' + (ctx ? 'present' : 'absent') + ' ctx.get=' + !!(ctx && ctx.get) + ' ctx.effect=' + !!(ctx && ctx.effect) + ' live=' + !!live);
  if (live) {
    diag('apply:skip-already-live')
    return () => { live = null }
  }
  const autoStart = config.autoStart !== false
  const maxSec = Number(config.maxSec || 30)
  const speak = config.speak !== false
  bubbleEnabled = config.bubble !== false

  let voice = null
  let active = true
  let settings = null


  // Lifetime: when the profile is torn down (or this plugin is unloaded), tear the
  // tap down with it so the host process exits clean (no lingering CFRunLoop thread).
  if (ctx && typeof ctx.effect === 'function') {
    try { ctx.effect(() => () => { active = false; voice?.stop(); bubbleClose() }, 'dsh-nico:lifetime') } catch {}
    // The custom client tab owns the UI; suppress the host's auto-generated form.
    try {
      const forms = ctx.get?.('settings')
      if (forms && typeof forms.configure === 'function') {
        ctx.effect(() => forms.configure({ auto: false }, ctx.fiber), 'dsh-nico:settings-presentation')
      }
    } catch {}
  }

  const start = async () => {
    diag('start:entry autoStart=' + autoStart + ' bubble=' + bubbleEnabled);
    // Wait for the host to settle, like lark-channel does via the loader service.
    const loader = ctx?.get?.('loader')
    diag('start:loader=' + (loader ? 'present' : 'absent') + ' hasAwait=' + !!(loader && loader.await));
    if (loader && typeof loader.await === 'function') {
      try { diag('start:awaiting loader…'); await loader.await(); diag('start:loader resolved') } catch (e) { diag('start:loader await threw ' + (e && e.message)) }
    }
    diag('start:post-loader active=' + active);
    if (!active || !autoStart) { diag('start:early-return active=' + active + ' autoStart=' + autoStart); live = null; return }

    // Register the nico settings section (reasoning + speech model selection).
    try {
      const { NicoSettings } = await import('./settings.mjs')
      settings = new NicoSettings(ctx, config)
      const { setSettings, setGreeting, setLlmService } = await import('./dsh.mjs')
      setSettings(settings)   // runCommand now applies the selected reasoning route
      setGreeting(settings.greeting())   // session bootstrap text, GUI-customizable
      setLlmService(ctx.get?.('llm') || null, ctx.get?.('settings') || null)   // cloud STT / custom route read the host's own model config
    } catch (e) { log('settings 注册失败，用宿主默认模型：' + (e?.message || e)) }
    const { speakText, stopSpeaking, setTtsDiag } = await import('./tts.mjs')
    setTtsDiag((e) => diag('tts: ' + JSON.stringify(e)))
    const { setSttReasoningProvider } = await import('./stt.mjs')
    setSttReasoningProvider(settings?.reasoningRoute?.()?.provider || null)

    // ── GUI → plugin install commands ────────────────────────────────────────
    // The settings GUI may only write VOLATILE leaves (dsh-settings rejects
    // ordinary fields), so the deploy card writes tts.install and the plugin
    // learns about it from the loader's volatile-update commit event, runs the
    // action, then resets install to '' (also volatile, so no remount).
    let installBusy = false
    let lastInstall = null
    // Volatile Config leaves arrive as live references (see settings.mjs unwrap);
    // read through .get() so the closure sees the freshly committed value.
    const unwrap = (v) => (v && typeof v.get === 'function') ? v.get() : v
    const readInstall = () => {
      const tts = config.tts || {}
      return { action: unwrap(tts.install) || '', url: unwrap(tts.url) || '' }
    }
    const runInstall = async (action) => {
      if (!action || action === lastInstall || installBusy) return
      if (action !== 'deploy' && action !== 'start' && action !== 'stop') return
      installBusy = true
      lastInstall = action
      try {
        const setup = await import('./tts-setup.mjs')
        // No settings writes here: runtime configEditor edits carry a fatal
        // compose check (2026-11-10 host crash). Progress lands on disk in
        // ~/.dsh/nico/cosyvoice/deploy-status.json + deploy.log; the GUI
        // observes liveness by probing the service URL.
        const ttsUrl = readInstall().url || 'http://127.0.0.1:59993/v1'
        if (action === 'deploy') setup.deployCosyVoice(ttsUrl)
        else if (action === 'start') await setup.startCosyVoice(ttsUrl)
        else if (action === 'stop') await setup.stopCosyVoice()
      } catch (e) {
        log('CosyVoice ' + action + ' 失败：' + (e?.message || e))
      } finally {
        installBusy = false
        lastInstall = ''
      }
    }
    // Recovery path: an install value already pending when (re)applied.
    void runInstall(readInstall().action)
    // Live path: the GUI's volatile write lands and the loader commits it.
    if (ctx && typeof ctx.on === 'function') {
      try {
        const off = ctx.on('loader/volatile-update', (paths) => {
          try {
            const flat = JSON.stringify(paths || '')
            if (!flat.includes('"tts"') || !flat.includes('"install"')) return
            void runInstall(readInstall().action)
          } catch {}
        })
        if (typeof off === 'function') ctx.effect?.(() => off, 'dsh-nico:volatile-update')
      } catch (e) { diag('volatile-update listener failed: ' + (e?.message || e)) }
    }

    // Build the catalogs (which models exist) for the route label + future pickers.
    let catalog = []
    try {
      const { modelCatalogs } = await import('./models.mjs')
      const cats = await modelCatalogs(ctx)
      catalog = cats.reasoning.catalog || []
      routeDefault = cats.reasoning.default || null
    } catch (e) { log('模型目录读取失败：' + (e?.message || e)) }

    diag('start:building voice catalog=' + catalog.length + ' routeDefault=' + (routeDefault && routeDefault.provider) + '/' + (routeDefault && routeDefault.model));
    const { NicoVoice } = await import('./voice.mjs')
    const sttSel = settings?.sttSelection?.() || { engine: 'local', model: null }
    const ttsSel = settings?.ttsSelection?.() || { engine: 'say' }
    const label = routeLabel(settings || { reasoningRoute: () => null }, catalog)
    log('当前模型：' + label + '；识别：' + sttSel.engine + (sttSel.model ? '/' + sttSel.model : '') +
      '；播报：' + ttsSel.engine + (ttsSel.engine === 'cosyvoice' ? ' (' + (ttsSel.url || '') + ')' : ''))

    // Attach listeners BEFORE start(): start() blocks ~100ms in mod.start() then
    // emits 'ready' synchronously — a listener attached after the constructor
    // call would miss it (same class of bug the CLI test hit).
    voice = new NicoVoice({
      maxSec,
      // Resolve the TTS selection PER CALL (not once here): the settings GUI
      // writes volatile leaves that NicoSettings.ttsSelection() reads live, so
      // a voice/instruct/speed change takes effect on the next utterance
      // without restarting the host.
      say: speak ? (text, onPlaying) => {
        void speakText(text, settings?.ttsSelection?.(), onPlaying)
          .then((r) => { if (!r.ok || r.fallback) log('播报异常/回退：' + JSON.stringify(r)) })
          .catch(() => {})
      } : () => {},
      sttSelection: sttSel,
    })
    // 人物窗「新会话」按钮 → 立即轮换固定会话（与语音触发同语义）。创建失败
    // 用 fail 气泡说出；确认/失败文案都走同一个 TTS 选择（每次调用现读）。
    bubbleEventHandler = async (obj) => {
      if (obj?.event !== 'new-session') return
      try {
        const { resetSession, ensureSession } = await import('./dsh.mjs')
        stopSpeaking()   // 按钮点击 = 新任务进入，掐掉在途播报
        resetSession()
        ensureSession()
        lastReply = '好的，已开启新会话。'
        pushState('reply-ok', { reply: lastReply })
        pushState('speak', { reply: lastReply })
        if (speak) { try { await speakText(lastReply, settings?.ttsSelection?.()) } catch {} }
        // end 态触发 Swift 的 1.6s 延迟淡出；speak=false 时直接收气泡。
        pushState('tts-done', { reply: lastReply })
      } catch (e) {
        const msg = '新会话创建失败：' + (e?.message || e)
        lastReply = msg
        pushState('fail', { text: msg })
        if (speak) void speakText(msg, settings?.ttsSelection?.()).catch(() => {})
      }
    }
    diag('start:voice constructed, attaching listeners');
    voice.on('ready', () => {
      log('右⌘ 热键就绪，按住说话'); diag('start:voice ready → tap installed')
      // 人物常驻：daemon 就绪即发一次 idle（eventToState 不认识 idle，直接走
      // bubbleSend），让人物在首次语音前就常驻在屏上待机。
      if (bubbleEnabled) { bubbleEnsure(); bubbleSend({ op: 'state', state: 'idle' }) }
    })
    voice.on('rec-start', () => { log('录音…'); pushState('rec-start') })
    voice.on('transcript', (t, meta) => { diag('voice:transcript len=' + (t?t.length:0));
      log('识别：' + (t || '（静默）'))
      if (t) pushState('transcript', { text: t })
    })
    voice.on('reply', ({ ok, reply, reason }) => {
      log('执行' + (ok ? '' : '失败') + ' → ' + (reply || reason || ''))
      lastReply = reply
      if (ok) pushState('reply-ok', { reply })
      // 人物常驻：fail 只由 Swift 收气泡（1.6s 延迟），不再 bubbleClose 杀整个
      // overlay 进程（那会把 charPanel 一起带走）。
      else pushState('fail', { text: reply })
    })
    // speaking state starts when AUDIO starts (tts-playing), not when synthesis
    // starts (tts-start) — otherwise the character mouths silence for ~10s of
    // CPU synthesis and finishes before anything is audible.
    voice.on('tts-playing', () => pushState('speak', { reply: lastReply }))
    voice.on('tts-done', () => pushState('tts-done', { reply: lastReply }))
    voice.on('rec-fail', (r) => { diag('voice:rec-fail ' + JSON.stringify(r).slice(0,200)); pushState('fail', { text: '录音失败' }) })
    voice.on('permission-denied', (info) => {
      diag('voice:permission-denied ' + JSON.stringify(info).slice(0,300))
      log('输入监控权限不足：系统设置 → 隐私与安全性 → 输入监控，授予宿主（DeepSeek Harness / com.deepseek.dsh），重启后生效')
    })
    voice.on('exit', (code, signal) => {
      if (code && code !== 0) log('热键进程退出 code=' + code + ' signal=' + (signal || ''))
    })
    voice.on('stderr', (s) => diag('hotkey:stderr ' + String(s).slice(0,200)))
    voice.on('error', (e) => diag('hotkey:error ' + (e && e.message || e)))
    voice.on('exit', (code, signal) => diag('hotkey:exit code=' + code + ' signal=' + signal))
    diag('start:calling voice.start()');
    try { voice.start() } catch (e) { diag('start:voice.start() THREW ' + (e && e.stack || e)); }
    if (active) live = voice
    diag('start:done');
  }

  void start().catch((e) => { log('启动失败：' + (e?.message || e)); diag('start:async-THREW ' + (e && e.stack || e)) })

  return () => {
    active = false
    if (live === voice) live = null
    voice?.stop()
    voice = null
    bubbleClose()
  }
}
