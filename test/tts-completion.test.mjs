import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

// The voice loop emits tts-done after awaiting say(). If say() is
// fire-and-forget, tts-done fires before audio starts, the later tts-playing
// event re-enters speaking, and nothing ever leaves it (mouth keeps moving).
test('say() returns the playback promise so tts-done lands after audio', () => {
  const idx = read('lib/index.js')
  assert.match(idx, /say: speak \? async \(text, onPlaying\) =>/, 'say is async')
  assert.match(idx, /await speakText\(/, 'speakText is awaited')
  assert.doesNotMatch(idx, /say: speak \? \(text, onPlaying\) => \{\s*void speakText\(/,
    'the say wrapper is not fire-and-forget')
})

test('voice emits tts-done only after say() resolves', () => {
  const voice = read('lib/voice.mjs')
  assert.match(voice, /await this\.say\(speakable\(reply\)[\s\S]{0,200}tts-done/, 'ordered await → tts-done')
})
