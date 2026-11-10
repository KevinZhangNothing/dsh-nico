import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { Hotkey } from '../lib/hotkey.mjs'

const mediaPoster = '/tmp/nico-post-media-test'
const yPoster = '/tmp/nico-post-y-test'
before(() => {
  execFileSync('swiftc', ['test/post-media.swift', '-o', mediaPoster], { stdio: 'ignore', timeout: 30000 })
  execFileSync('swiftc', ['test/post-y.swift', '-o', yPoster], { stdio: 'ignore', timeout: 30000 })
})

test('Y stays untouched, short media stays media, long media drives Nico', { timeout: 15000 }, async () => {
  const events = []
  const hotkey = new Hotkey()
  hotkey.on('media-toggle-start', () => events.push('start'))
  hotkey.on('media-toggle-stop', () => events.push('stop'))
  hotkey.on('error', (error) => { throw error })
  hotkey.start()
  assert.equal(hotkey.ready, true)
  try {
    execFileSync(yPoster, ['down'], { stdio: 'ignore' })
    execFileSync(yPoster, ['up'], { stdio: 'ignore' })
    await delay(250)
    assert.deepEqual(events, [], 'ordinary keycode 16 (Y) must not be intercepted')

    execFileSync(mediaPoster, ['down'], { stdio: 'ignore' })
    execFileSync(mediaPoster, ['up'], { stdio: 'ignore' })
    await delay(250)
    assert.deepEqual(events, [], 'short media press must not trigger Nico')

    execFileSync(mediaPoster, ['down'], { stdio: 'ignore' })
    await delay(650)
    assert.deepEqual(events, [], 'long hold must not record while the microphone is muted')
    execFileSync(mediaPoster, ['up'], { stdio: 'ignore' })
    await delay(250)
    assert.deepEqual(events, ['start'], 'release must start headset microphone recording')
    execFileSync(mediaPoster, ['down'], { stdio: 'ignore' })
    await delay(650)
    assert.deepEqual(events, ['start'], 'second long hold must not stop before release')
    execFileSync(mediaPoster, ['up'], { stdio: 'ignore' })
    await delay(250)
    assert.deepEqual(events, ['start', 'stop'], 'second long release must stop without media replay')
  } finally {
    hotkey.stop()
  }
})
