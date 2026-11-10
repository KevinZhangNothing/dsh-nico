#!/usr/bin/env node
// Nico CLI — 按住右⌘说一句 → 本地 AI 替我操作电脑
// Usage:
//   nico record <out.wav> [max-sec]   录麦（ffmpeg avfoundation :0）
//   nico say <wav>                    STT → DSH → say 朗读
//   nico chat <text...>               文本直发（调试）
//   nico daemon                       常驻：右⌘ hold 录音 → say（需 TCC 授权）
//   nico sid                          显示/创建固定会话 id
//   nico setup                        把 sherpa-onnx 运行时从 app.asar 抽取到 ~/.dsh/nico/rt
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
import { transcribeFile } from '../lib/stt.mjs'
import { runCommand, getSid, ensureSession } from '../lib/dsh.mjs'
import { startRecording } from '../lib/recorder.mjs'
import { NICO_DIR, SESSION_ID_FILE } from '../lib/paths.mjs'

const [,, cmd, ...rest] = process.argv

function say(text) {
  if (!text) return
  spawnSync('say', [text], { stdio: 'ignore' })
}

async function runCommandAndSpeak(text) {
  if (!text || text === '（静默）') { say('没听清，请再说一次。'); return }
  const { reply } = await runCommand(text)
  say(reply)
  console.log(reply)
}

function doRecord(out, max) {
  const h = startRecording({ maxSec: max })
  console.error('录音中… 按 Ctrl-C 或等待 ' + max + 's')
  h.done.then((r) => {
    if (r.ok) console.log(r.wav)
    else { console.error('录音失败: ' + (r.error || 'code=' + r.code)); process.exit(1) }
  })
  // for CLI: just wait maxSec (no hotkey in this path)
  process.stdin.setRawMode?.(true)
  process.stdin.on('data', () => { h.stop() })
}

function doDaemon() {
  // Reuse the SAME hold-to-talk loop the cordis parasite uses (lib/voice.mjs).
  return import('../lib/voice.mjs').then(({ NicoVoice }) => {
    // Attach handlers before .start(): start() emits 'ready' synchronously.
    const voice = new NicoVoice({ maxSec: 30, say })
    voice.on('ready', () => console.error('nico: 热键就绪，按住右⌘说话'))
    voice.on('rec-start', () => console.error('nico: 录音…'))
    voice.on('transcript', (t) => console.error('nico: ' + (t || '（静默）')))
    voice.on('reply', ({ ok, reply, reason }) => {
      console.error('nico: 执行' + (ok ? '' : '失败') + (reason ? ' ' + JSON.stringify(reason) : ''))
      console.log(reply)
    })
    voice.on('permission-denied', () =>
      console.error('nico: 无法安装键盘热键（输入监控权限不足）。请在 系统设置 → 隐私与安全性 → 输入监控 中授予宿主（DeepSeek Harness / 本终端），然后重启。'))
    voice.on('exit', (code) => {
      if (code !== 0 && code !== null) console.error('nico: 热键进程异常退出 code=' + code)
      process.exit(code || 0)
    })
    voice.start()
    console.error('nico: daemon 启动中…（等待热键就绪）')
  })
}

function doSetup() {
  const r = spawnSync('node', [join(PLUGIN_DIR, 'scripts', 'setup-rt.mjs')], { stdio: 'inherit' })
  process.exit(r.status || 0)
}

switch (cmd) {
  case 'record': doRecord(rest[0], Number(rest[1] || 30)); break
  case 'say': {
    const wav = rest[0];
    if (!wav) { console.error('usage: nico say <wav>'); process.exit(2) }
    const text = transcribeFile(wav)
    console.error('nico: ' + text)
    runCommandAndSpeak(text)
    break
  }
  case 'chat': runCommandAndSpeak(rest.join(' ')); break
  case 'sid': console.log(getSid()); break
  case 'daemon': doDaemon(); break
  case 'setup': doSetup(); break
  default:
    console.error('usage: nico record|say|chat|daemon|sid|setup [args]')
    process.exit(2)
}