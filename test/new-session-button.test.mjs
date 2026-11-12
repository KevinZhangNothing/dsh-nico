import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

// 接线冒烟：人物窗「新会话」按钮 → Swift stdout 事件 → 插件处理器。
// 任何一环改名，这里先红（完整行为靠人工清单验证）。

test('swift overlay emits the new-session event on stdout', () => {
  const swift = read('native/bubble.swift')
  assert.match(swift, /newSessionClicked/, 'action handler exists')
  assert.match(swift, /\{\"event\":\"new-session\"\}/, 'emits one-line JSON to stdout')
  assert.match(swift, /charBox\.addSubview\(newSessionButton\)/, 'button is mounted on the char window')
})

test('plugin consumes the event and rotates the session', () => {
  const idx = read('lib/index.js')
  assert.match(idx, /stdio: \['pipe', 'pipe', 'ignore'\]/, 'stdout must be piped, not dropped')
  assert.match(idx, /bubbleEventHandler/, 'handler hook registered')
  assert.match(idx, /event !== 'new-session'/, 'dispatches on the new-session event')
  const dsh = read('lib/dsh.mjs')
  assert.match(dsh, /export function resetSession/, 'rotation primitive exists')
  assert.match(dsh, /export function ensureSession/, 'eager creation primitive exists')
})

test('button follows the reported head position', () => {
  assert.match(read('native/overlay/model.js'), /nicoHead/, 'model.js reports head position')
  const swift = read('native/bubble.swift')
  assert.match(swift, /name: "nicoHead"/, 'swift consumes the head message')
  assert.match(swift, /headX/, 'layout uses the head coordinates')
})

test('ffplay device failure is a fail, not a silent ok', () => {
  const tts = read('lib/tts.mjs')
  assert.match(tts, /could not initialize sdl/i, 'stderr guard for SDL init failure')
  assert.match(tts, /'pipe', 'ignore', 'pipe'/, 'stderr must be captured')
})

test('bubble binary recompiles when the swift source is newer', () => {
  const idx = read('lib/index.js')
  assert.match(idx, /mtimeMs >= statSync\(BUBBLE_SRC\)\.mtimeMs/, 'stale-binary rebuild guard')
})
