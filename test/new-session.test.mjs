import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isNewSessionCommand, resetSession } from '../lib/dsh.mjs'

test('new-session phrases from STT are recognized', () => {
  for (const t of [
    '新会话', '新的会话', '新开一个会话', '开一个新会话', '重新开一个会话',
    '重开会话', '换个新会话', '新对话', '清空会话', '清空上下文',
    '新会话。', '  new session ', 'NewSession', '开启新会话，我要说新的任务',
  ]) {
    assert.ok(isNewSessionCommand(t), 'should match: ' + t)
  }
})

test('ordinary commands containing similar words are not hijacked', () => {
  for (const t of [
    '帮我整理桌面', '打开一个新的文件夹', '新开一个文件夹叫报告',
    '把会话记录导出', '介绍一下这个项目', '重启一下服务',
  ]) {
    assert.equal(isNewSessionCommand(t), false, 'should NOT match: ' + t)
  }
})

test('resetSession drops the session id file and tolerates absence', async () => {
  process.env.NICO_HOME = mkdtempSync(join(tmpdir(), 'nico-test-'))
  const { SESSION_ID_FILE } = await import('../lib/paths.mjs')
  writeFileSync(SESSION_ID_FILE, 'sid-123', { mode: 0o600 })
  resetSession()
  assert.equal(existsSync(SESSION_ID_FILE), false)
  resetSession() // absent → no-throw
  assert.equal(existsSync(SESSION_ID_FILE), false)
})
