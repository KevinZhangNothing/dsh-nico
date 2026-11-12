import test from 'node:test'
import assert from 'node:assert/strict'
import { greeting, setGreeting, setSettings } from '../lib/dsh.mjs'
import { speakable } from '../lib/voice.mjs'

test('default greeting carries the voice-output contract', () => {
  setGreeting(null)
  setSettings(null)
  const g = greeting()
  assert.match(g, /独立任务执行/)
  // The complaint this fixes: without reply-shape rules the session reads back
  // whole task results through TTS.
  assert.match(g, /语音朗读/)
  assert.match(g, /不超过两句话/)
  assert.match(g, /收到$/)
})

test('custom greeting is appended after the contract, exactly once', () => {
  setSettings({ greeting: () => '完成后提醒我确认' })
  const g = greeting()
  assert.match(g, /独立任务执行/)
  assert.match(g, /完成后提醒我确认$/)
  assert.equal(g.match(/独立任务执行/g).length, 1, 'contract must not double')
  setSettings(null)
  assert.equal(greeting().match(/独立任务执行/g).length, 1)
  setGreeting(null)
})

test('speakable passes short replies through untouched', () => {
  assert.equal(speakable('收到'), '收到')
  assert.equal(speakable('  好的，已完成。'), '好的，已完成。')
  assert.equal(speakable(''), '')
  assert.equal(speakable(null), '')
})

test('speakable caps long task reports at a sentence boundary', () => {
  const long = '已经完成重构。'.repeat(60)
  const out = speakable(long)
  assert.ok(out.length <= 105, 'capped output, got ' + out.length)
  assert.ok(out.endsWith('……'))
  assert.ok(out.startsWith('已经完成重构。'))
  // No sentence boundary inside the window → hard cut, still capped.
  const noBoundary = 'x'.repeat(500)
  assert.ok(speakable(noBoundary).length <= 103)
})
