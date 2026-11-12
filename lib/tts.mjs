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

// ── 打断：新任务开始时，上一条没播完的播报立即停止 ────────────────────
// 每个播放路径（say / afplay / ffplay 流）注册一个 stop 闭包；stopSpeaking()
// 全部触发并清空。调用点：rec-start（新语音任务进入）、新 speakText 开头、
// 「新会话」按钮。
const activePlayers = new Set()

export function stopSpeaking() {
  for (const stop of [...activePlayers]) { try { stop() } catch {} }
  activePlayers.clear()
}

function trackStop(stop) {
  activePlayers.add(stop)
  return () => activePlayers.delete(stop)
}

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

// ffplay is the streaming player; resolve once, lazily. The desktop host's PATH
// is launchd-minimal (/usr/bin:/bin:…) and does NOT include /opt/homebrew/bin,
// so a bare 'ffplay' spawn silently ENOENTs and every reply degrades to the
// slow whole-file wav path — probe absolute candidates too.
let ffplayBin = null
function ffplayPath() {
  if (ffplayBin !== null) return ffplayBin
  for (const c of ['ffplay', '/opt/homebrew/bin/ffplay', '/usr/local/bin/ffplay']) {
    try {
      if (spawnSync(c, ['-version'], { stdio: 'ignore' }).status === 0) { ffplayBin = c; return ffplayBin }
    } catch {}
  }
  ffplayBin = ''
  return ffplayBin
}

function playWav(file, onPlaying) {
  return new Promise((resolve) => {
    try {
      const p = spawn('afplay', [file], { stdio: 'ignore' })
      const untrack = trackStop(() => { try { p.kill() } catch {} })
      if (typeof onPlaying === 'function') onPlaying()   // afplay starts almost instantly
      p.on('exit', () => { untrack(); resolve(true) })
      p.on('error', () => { untrack(); resolve(false) })
    } catch { resolve(false) }
  })
}

function saySay(text, onPlaying) {
  return new Promise((resolve) => {
    try {
      const p = spawn('say', [text], { stdio: 'ignore' })
      const untrack = trackStop(() => { try { p.kill() } catch {} })
      if (typeof onPlaying === 'function') onPlaying()
      p.on('exit', () => { untrack(); resolve({ engine: 'say', ok: true }) })
      p.on('error', (e) => { untrack(); resolve({ engine: 'say', ok: false, error: e?.message || String(e) }) })
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
// 导出仅供回归测试：SDL 音频目标失败时必须返回 'fail'（ffplay 仍 exit 0）。
export async function playPcmStream(text, sel, onPlaying) {
  let res
  const ac = new AbortController()   // stopSpeaking 时连同合成流一起掐断
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
      signal: ac.signal,
    })
  } catch { return 'fail' }
  if (!res.ok || !res.body) return 'fail'
  const rate = parseInt(res.headers.get('x-sample-rate') || '24000', 10) || 24000
  return await new Promise((resolve) => {
    let ff
    try {
      // NOTE: no -ac — ffplay 8.1 rejects it ("Option not found") and dies at
      // startup, silently degrading every reply to the slow whole-wav path;
      // raw s16le defaults to mono anyway.
      // -loglevel error（不能 quiet）：SDL 音频目标初始化失败时 ffplay 仍 exit 0，
      // 报错是唯一的失败信号；quiet 会把它吞掉，静音被当成成功。
      ff = spawn(ffplayPath(), ['-nodisp', '-autoexit', '-loglevel', 'error',
        '-f', 's16le', '-ar', String(rate), '-i', '-'], { stdio: ['pipe', 'ignore', 'pipe'] })
    } catch { return resolve('fail') }
    // -loglevel quiet 吞掉报错，但「音频设备没开成」必须知道：ffplay 在
    // SDL 音频目标初始化失败时照常把流消费完并 exit 0（实测复现），静音
    // 却被当成成功。抓 stderr 尾部，设备失败一律判 fail 落回 afplay/say。
    let errTail = ''
    ff.stderr?.on('data', (d) => { errTail = (errTail + String(d)).slice(-400) })
    let started = false
    let wroteAny = false
    let settled = false
    const untrack = trackStop(() => { try { ff.kill() } catch {}; try { ac.abort() } catch {} })
    const done = (code) => {
      if (settled) return
      settled = true
      untrack()
      if (/could not initialize sdl|audio target|failed to open audio|no audio output/i.test(errTail)) code = 'fail'
      resolve(wroteAny ? code : 'fail')
    }
    // A child 'error' AFTER chunks were written must be 'partial' — resolving
    // 'fail' would fall through to the wav path and double-speak the reply.
    ff.on('error', () => done(wroteAny ? 'partial' : 'fail'))
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
  // 新播报开始：上一条没播完的立即停（新任务进入，旧的不需要播完）。
  stopSpeaking()
  const sel = normalizeTtsSelection(selection)
  if (sel.engine === 'cosyvoice') {
    if (ffplayPath()) {
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
