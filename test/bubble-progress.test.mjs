import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

// 接线冒烟：headless --json 事件 → dsh.mjs 流式解析 → voice 事件 → index 状态
// → bubble 页面渲染。任何一环改名，这里先红；行为细节由 progress/overlay 测试覆盖。

test('dsh streams run events instead of buffering the whole run', () => {
  const dsh = read('lib/dsh.mjs')
  assert.match(dsh, /export function normalizeProgress/, 'event projection exists')
  assert.match(dsh, /spawn\(DSH, args/, 'run uses spawn, not spawnSync')
  assert.match(dsh, /onProgress\?\.\(progress\)/, 'parsed events are forwarded while live')
  assert.match(dsh, /onProgress = null/, 'runCommand accepts a progress sink')
})

test('voice forwards progress without touching playback', () => {
  const voice = read('lib/voice.mjs')
  assert.match(voice, /onProgress: \(ev\) =>/, 'voice passes the sink')
  assert.match(voice, /this\.emit\('progress', ev\)/, 'emits a progress event')
})

test('plugin entry maps progress to a bubble state', () => {
  const idx = read('lib/index.js')
  assert.match(idx, /voice\.on\('progress'/, 'listener registered')
  assert.match(idx, /progressView\(progress, lastTranscript\)/, 'reducer output is rendered')
  assert.match(idx, /pushState\('progress'/, 'pushes the working state')
})

test('bubble page renders the step rows', () => {
  const js = read('native/overlay/bubble.js')
  assert.match(js, /working:\s*\[/, 'working header exists')
  assert.match(js, /function renderSteps/, 'step renderer exists')
  assert.match(js, /s\.steps/, 'consumes s.steps')
  const html = read('native/overlay/bubble.html')
  assert.match(html, /id="steps"/, 'step container exists')
})
