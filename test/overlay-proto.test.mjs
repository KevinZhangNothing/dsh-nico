import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventToState, decorate, legacyShow } from '../lib/overlay-proto.mjs'

test('rec-start → listening 带默认 hint', () => {
  const s = decorate(eventToState('rec-start'))
  assert.equal(s.state, 'listening')
  assert.match(s.hint, /Release to send/)
  assert.equal(s.motion, 'Idle')
  assert.equal(s.exp, 'f01_normal')
})

test('transcript(有文本) → thinking 带 sleepy 表情', () => {
  const s = decorate(eventToState('transcript', { text: '整理桌面' }))
  assert.equal(s.state, 'thinking')
  assert.equal(s.text, '整理桌面')
  assert.equal(s.exp, 'f08_sleepy')
})

test('transcript(空文本) → null', () => {
  assert.equal(eventToState('transcript', { text: '' }), null)
})

test('reply ok → start(Nod+surprised)；fail → Shake+angry', () => {
  assert.equal(decorate(eventToState('reply-ok', { reply: '好' })).motion, 'Nod')
  const f = decorate(eventToState('fail', { text: ' boom' }))
  assert.equal(f.motion, 'Shake')
  assert.equal(f.exp, 'f03_angry')
})

test('speak → speaking(f02_smile, 无 motion)；tts-done → end(Bow)', () => {
  const sp = decorate(eventToState('speak', { reply: 'x' }))
  assert.equal(sp.state, 'speaking'); assert.equal(sp.exp, 'f02_smile')
  const en = decorate(eventToState('tts-done', { reply: 'x' }))
  assert.equal(en.motion, 'Bow')
})

test('覆盖缺口：未知事件 / fail 默认文案 / 各状态 exp 与 motion', () => {
  assert.equal(eventToState('nope'), null)
  assert.equal(decorate(eventToState('fail', {})).text, '录音失败')
  assert.equal(decorate(eventToState('reply-ok', { reply: '好' })).exp, 'f05_surprised')
  assert.equal(decorate(eventToState('speak', { reply: 'x' })).motion, null)
  assert.equal(decorate(eventToState('tts-done', { reply: 'x' })).exp, 'f02_smile')
})

test('legacyShow 兼容旧 emoji 前缀', () => {
  assert.equal(legacyShow('🎙 录音中…').state, 'listening')
  assert.equal(legacyShow('✅ done').state, 'end')
  assert.equal(legacyShow('⚠️ bad').state, 'fail')
  assert.equal(legacyShow('📝 text').state, 'thinking')
  assert.equal(legacyShow('其他').state, 'listening')
  assert.equal(legacyShow('📝 text').text, 'text')
  assert.equal(legacyShow('⚠️ bad').text, 'bad')
})
