import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

test('client bundle registers the canonical package id', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registration
  const window = {
    __ModuleLoader__: {
      load(value) { registration = value },
    },
  }

  vm.runInNewContext(source, { window })

  const expected = 'dsh-nico'
  assert.equal(
    registration?.id,
    expected,
    `client bundle loaded without registering "${expected}" via __ModuleLoader__.load`,
  )
})
