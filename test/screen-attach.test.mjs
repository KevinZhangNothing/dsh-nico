import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wantsScreen, attachScreen, cleanupScreen } from '../lib/screen.mjs'
import { isCancelCommand } from '../lib/voice.mjs'

test('wantsScreen hits explicit screen / look wording', () => {
  for (const t of [
    '这个报错是什么',
    '看看我的屏幕',
    '帮我看看当前窗口',
    '屏幕上这个数字是多少',
    '这是什么意思',
    '这是怎么回事',
    '帮我把这个窗口关了',
    '读一下屏幕上的内容',
    'what is this error',
    'check my screen',
  ]) assert.ok(wantsScreen(t), 'should hit: ' + t)
})

test('wantsScreen misses ordinary commands', () => {
  for (const t of [
    '今天天气怎么样',
    '帮我整理桌面文件夹',        // 整理桌面 without 看 wording
    '把当前目录下的文件列出来',   // 当前目录 is not the screen
    '写一个 python 脚本',
    '新开一个对话',
    '',
  ]) assert.equal(wantsScreen(t), false, 'should miss: ' + t)
})

test('attachScreen enriches text with the screenshot hint', async () => {
  let calls = 0
  const { text, png } = await attachScreen('这个报错是什么', {
    capture: () => { calls++; return '/tmp/fake/screen.png' },
  })
  assert.equal(calls, 1)
  assert.ok(png === '/tmp/fake/screen.png')
  assert.ok(text.startsWith('这个报错是什么'))
  assert.ok(text.includes('/tmp/fake/screen.png'))
  assert.ok(text.includes('read_image'))
})

test('attachScreen skips capture when the trigger misses', async () => {
  let calls = 0
  const { text, png } = await attachScreen('今天天气怎么样', {
    capture: () => { calls++; return '/tmp/fake/screen.png' },
  })
  assert.equal(calls, 0)
  assert.equal(png, null)
  assert.equal(text, '今天天气怎么样')
})

test('attachScreen degrades to text-only when capture fails', async () => {
  const { text, png } = await attachScreen('看看我的屏幕', { capture: async () => null })
  assert.equal(png, null)
  assert.equal(text, '看看我的屏幕')
})

test('cleanupScreen deletes the capture and its temp dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nico-screen-test-'))
  const png = join(dir, 'screen.png')
  writeFileSync(png, 'x')
  assert.ok(existsSync(png))
  cleanupScreen(png)
  assert.equal(existsSync(png), false)
  assert.throws(() => statSync(dir), /ENOENT/)
  cleanupScreen(null) // must not throw
})

test('isCancelCommand matches whole-utterance withdrawals only', () => {
  for (const t of ['算了', '取消', '不要了', '没事了', '好了好了', '算了吧。', 'Never mind', 'cancel it!'])
    assert.ok(isCancelCommand(t), 'should cancel: ' + t)
  for (const t of ['算了，还是把桌面整理一下', '取消订单', '不要了，改成明天', '我取消不了'])
    assert.equal(isCancelCommand(t), false, 'should NOT cancel: ' + t)
})
