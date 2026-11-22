import test from 'node:test'
import assert from 'node:assert/strict'
import { pickAudioDevice } from '../lib/recorder.mjs'

const list = (audioRows, videoRows = ['[0] FaceTime高清相机']) => [
  '[AVFoundation indev @ 0x7f] AVFoundation video devices:',
  ...videoRows.map((r) => '[AVFoundation indev @ 0x7f] ' + r),
  '[AVFoundation indev @ 0x7f] AVFoundation audio devices:',
  ...audioRows.map((r) => '[AVFoundation indev @ 0x7f] ' + r),
  '[in#0 @ 0x7f] Error opening input: Input/output error',
].join('\n')

test('built-in mic wins over a virtual device at index 0', () => {
  assert.equal(pickAudioDevice(list(['[0] MiRemoteV 2ch', '[1] MacBook Pro麦克风', '[2] LarkAudioDevice'])), 1)
  assert.equal(pickAudioDevice(list(['[0] BlackHole 2ch', '[1] MacBook Pro Microphone'])), 1)
})

test('falls back to the first audio device when no built-in is named', () => {
  assert.equal(pickAudioDevice(list(['[0] USB Audio CODEC', '[1] Aggregate Device'])), 0)
})

test('never picks a video device, and returns null with no audio', () => {
  assert.equal(pickAudioDevice(list([], ['[0] FaceTime高清相机', '[1] Capture screen 0'])), null)
  assert.equal(pickAudioDevice(''), null)
})
