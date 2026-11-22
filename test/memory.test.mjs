import test from 'node:test'
import assert from 'node:assert/strict'
import { isClearMemoryCommand, greeting } from '../lib/dsh.mjs'
import { MEMORY_FILE } from '../lib/paths.mjs'

test('isClearMemoryCommand matches memory-clearing utterances', () => {
  for (const t of ['清空记忆', '清空长期记忆', '清除记忆', '删掉长期记忆', '忘掉之前的话', '忘掉所有的记忆', '忘了我说过的话', 'forget everything', 'forget all'])
    assert.ok(isClearMemoryCommand(t), 'should clear: ' + t)
})

test('isClearMemoryCommand does not swallow session rotation or tasks', () => {
  for (const t of [
    '清空会话',            // session rotation, a different feature
    '清空会话上下文',
    '忘掉这个错误',         // a task, not memory management
    '记住我喜欢喝美式',      // remembering, the opposite
    '帮我删除临时文件',
    '',
  ]) assert.equal(isClearMemoryCommand(t), false, 'should NOT clear: ' + t)
})

test('greeting contract pins the memory file behavior', () => {
  const g = greeting()
  assert.ok(g.includes(String(MEMORY_FILE)), 'greeting must name the memory file: ' + g)
  assert.ok(g.includes('记住'), 'greeting must teach the remember verb')
  assert.ok(g.includes('先读'), 'greeting must require reading before answering')
})
