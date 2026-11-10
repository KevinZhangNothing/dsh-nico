import test from 'node:test'
import assert from 'node:assert/strict'
import { MediaHold } from '../lib/media-hold.mjs'
function fixture() {
  const events = []
  const hold = new MediaHold({
    onShort: () => events.push('short'),
    onToggleStart: () => events.push('start'),
    onToggleStop: () => events.push('stop'),
  })
  return { events, hold }
}
test('short press emits only media fallback', () => {
  const { events, hold } = fixture()
  hold.down(0); hold.tick(399); hold.up(399); hold.tick(1000)
  assert.deepEqual(events, ['short'])
})
test('long hold starts recording only after release', () => {
  const { events, hold } = fixture()
  hold.down(0); hold.tick(400)
  assert.deepEqual(events, [])
  hold.up(450)
  assert.deepEqual(events, ['start'])
})
test('next long hold stops only after release', () => {
  const { events, hold } = fixture()
  hold.down(0); hold.tick(400); hold.up(450)
  hold.down(1000); hold.tick(1400)
  assert.deepEqual(events, ['start'])
  hold.up(1450)
  assert.deepEqual(events, ['start', 'stop'])
})

test('short press during recording keeps media control without stopping', () => {
  const { events, hold } = fixture()
  hold.down(0); hold.tick(400); hold.up(450)
  hold.down(1000); hold.up(1100)
  assert.deepEqual(events, ['start', 'short'])
})
test('repeated keyDown does not reset or duplicate the hold', () => {
  const { events, hold } = fixture()
  hold.down(0); hold.down(100); hold.tick(399)
  assert.deepEqual(events, [])
  hold.tick(400); hold.down(450); hold.up(500)
  assert.deepEqual(events, ['start'])
})
test('stop suppresses pending callbacks', () => {
  const { events, hold } = fixture()
  hold.down(0); hold.stop(); hold.tick(1000); hold.up(1000)
  assert.deepEqual(events, [])
})
