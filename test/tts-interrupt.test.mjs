import test from 'node:test'
import assert from 'node:assert/strict'
import { speakText, stopSpeaking, playPcmStream } from '../lib/tts.mjs'

// 打断语义：新任务进入时，在途播报必须立即停（进程被杀，Promise 落定），
// 而不是等整段读完。

test('stopSpeaking kills in-flight playback', async () => {
  const long = '这是一段用于测试打断的很长很长的朗读文本，'.repeat(10)
  const p = speakText(long, { engine: 'say' })
  await new Promise((r) => setTimeout(r, 300))   // 让 say 起播
  stopSpeaking()
  const r = await Promise.race([
    p,
    new Promise((res) => setTimeout(() => res('timeout'), 2000)),
  ])
  assert.notEqual(r, 'timeout', 'playback promise must settle promptly after stop')
})

test('stopSpeaking with nothing playing is a no-op', () => {
  stopSpeaking()
  stopSpeaking()
})

test('ffplay with a dead audio target is fail, not silent ok', async () => {
  // 实测：SDL 音频目标打不开时 ffplay 照样消费完整流并 exit 0（-loglevel
  // quiet 连报错都吞掉）——曾让每条 CosyVoice 回复静音却被判成功。
  process.env.SDL_AUDIODRIVER = 'nonexistent'
  const outcome = await playPcmStream('测试', {
    url: process.env.NICO_TTS_URL || 'http://127.0.0.1:59993/v1',
  }, null).catch(() => 'fail')
  process.env.SDL_AUDIODRIVER = ''
  assert.equal(outcome, 'fail')
})
