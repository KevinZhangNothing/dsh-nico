import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCorrections, setCorrections, activeCorrections, loadCorrections } from '../lib/hotwords.mjs'
import { NicoSettings, NICO_SETTINGS_SHAPE } from '../lib/settings.mjs'

test('setCorrections injects a live map that wins over the file', () => {
  setCorrections({ 误词: '正词' })
  assert.equal(applyCorrections('误词'), '正词')
  assert.deepEqual(activeCorrections(), { 误词: '正词' })
  // Explicit map argument still wins over the injection.
  assert.equal(applyCorrections('误词', { 误词: '别词' }), '别词')
  setCorrections(null)
})

test('setCorrections clears back to the file on null/empty', () => {
  setCorrections({})
  assert.deepEqual(activeCorrections(), loadCorrections())
  setCorrections(null)
  assert.deepEqual(activeCorrections(), loadCorrections())
  setCorrections('garbage')
  assert.deepEqual(activeCorrections(), loadCorrections())
})

test('NICO_SETTINGS_SHAPE carries the corrections leaf', () => {
  assert.equal(NICO_SETTINGS_SHAPE.corrections, '')
})

test('NicoSettings.corrections reads config and falls back to file storage', () => {
  const fromConfig = new NicoSettings(null, { corrections: '{"a": "b"}' })
  assert.equal(fromConfig.corrections(), '{"a": "b"}')
  const empty = new NicoSettings(null, {})
  assert.equal(typeof empty.corrections(), 'string')
})
