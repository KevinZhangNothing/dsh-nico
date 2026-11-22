import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCorrections, loadCorrections, correctionsFile } from '../lib/hotwords.mjs'

test('applyCorrections replaces misheard terms, longest key first', () => {
  // Longer key must win over its prefix: 绘画按钮 before 绘画.
  const map = { 绘画: '会话', 绘画按钮: '新会话按钮', deepseek: 'DeepSeek' }
  assert.equal(applyCorrections('打开绘画按钮', map), '打开新会话按钮')
  assert.equal(applyCorrections('开一个新绘画', map), '开一个新会话')
  assert.equal(applyCorrections('hey deepseek 你好', map), 'hey DeepSeek 你好')
})

test('applyCorrections passes text through with empty/invalid maps', () => {
  assert.equal(applyCorrections('原样输出', {}), '原样输出')
  assert.equal(applyCorrections('', { a: 'b' }), '')
  // String coercion at the boundary — real callers only ever pass strings.
  assert.equal(applyCorrections(null, null), '')
})

test('applyCorrections replaces every occurrence', () => {
  assert.equal(applyCorrections('绘画绘画', { 绘画: '会话' }), '会话会话')
})

test('loadCorrections tolerates a missing or corrupt file', () => {
  // No fixture is written in the sandbox run; NICO_DIR may or may not have the
  // file — the contract is: never throw, always return a map.
  const m = loadCorrections()
  assert.ok(typeof m === 'object' && m !== null && !Array.isArray(m))
  assert.equal(typeof correctionsFile(), 'string')
  assert.ok(correctionsFile().endsWith('corrections.json'))
})
