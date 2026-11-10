#!/usr/bin/env node
// nico-daemon — launches the right-⌘ hold-to-talk daemon.
// Equivalent to: nico daemon
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const args = ['daemon', ...process.argv.slice(2)]
const child = spawn(process.execPath, [join(here, 'nico.js'), ...args], { stdio: 'inherit' })
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code || 0)))
