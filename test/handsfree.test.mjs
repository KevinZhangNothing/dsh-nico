import test from 'node:test'
import assert from 'node:assert/strict'
import { createSilenceWatcher } from '../lib/vad.mjs'
import { NicoSettings, NICO_SETTINGS_SHAPE } from '../lib/settings.mjs'

test('silence watcher ignores leading silence before any speech', () => {
  let hits = 0
  const w = createSilenceWatcher({ onEndpoint: () => hits++ })
  w.feed('[silencedetect @ 0x0] silence_start: 0.9')
  assert.equal(hits, 0)
  assert.equal(w.sawSpeech, false)
})

test('silence watcher endpoints on the first post-speech silence window', () => {
  let hits = 0
  const w = createSilenceWatcher({ onEndpoint: () => hits++ })
  // Speech begins (silence ends), then a silence window opens → endpoint.
  w.feed('silence_end: 1.2 | silence_duration: 0.5')
  w.feed('silence_start: 3.4')
  assert.equal(hits, 1)
  assert.equal(w.fired, true)
  // Only one endpoint per recording.
  w.feed('silence_end: 5')
  w.feed('silence_start: 6')
  assert.equal(hits, 1)
})

test('NICO_SETTINGS_SHAPE carries handsFree leaf', () => {
  assert.equal(NICO_SETTINGS_SHAPE.handsFree, false)
})

test('NicoSettings.handsFree reads boolean from config with false default', () => {
  assert.equal(new NicoSettings(null, { handsFree: true }).handsFree(), true)
  assert.equal(new NicoSettings(null, { handsFree: 'yes' }).handsFree(), false)
  assert.equal(new NicoSettings(null, {}).handsFree(), false)
})
