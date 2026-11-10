// Right-⌘ hotkey daemon. Hold to record, release to stop.
// Emits 'down' / 'up' events on a Node EventEmitter.
import { spawn, execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NICO_DIR } from './paths.mjs'
import { MediaHold } from './media-hold.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const ADDON_CANDIDATES = [
  join(__dirname, '..', 'native', 'build', 'Release', 'hotkey_tap.node'),
  join(__dirname, '..', 'native', 'build', 'Debug', 'hotkey_tap.node'),
]

let nativeMod = null
function loadNative() {
  if (nativeMod) return nativeMod
  for (const p of ADDON_CANDIDATES) {
    if (existsSync(p)) { try { nativeMod = require(p); return nativeMod } catch {} }
  }
  return null
}

class NativeHotkey extends EventEmitter {
  constructor() {
    super()
    this.ready = false
    this._timer = null
    this._stopped = false
    this._media = new MediaHold({
      onShort: () => {
        const mod = loadNative()
        if (mod && typeof mod.postPlayPause === 'function') mod.postPlayPause()
      },
      onToggleStart: () => this.emit('media-toggle-start'),
      onToggleStop: () => this.emit('media-toggle-stop'),
    })
  }
  start() {
    const mod = loadNative()
    if (!mod) { this.emit('no-native'); return this }
    try { mod.start(() => {}) } catch (e) { this.emit('error', e); return this }
    this.ready = !!mod.ready()
    if (this.ready) this.emit('ready')
    else this.emit('permission-denied', { reason: 'native-tap-null' })
    this._timer = setInterval(() => {
      if (this._stopped) return
      const now = Date.now()
      const s = mod.drain()
      if (s.pending) {
        if (s.kind === 1) {
          if (s.down) this._media.down(now)
          else this._media.up(now)
        } else this.emit(s.down ? 'down' : 'up')
      }
      this._media.tick(now)
    }, 33)
    this._timer.unref?.()
    return this
  }
  stop() {
    if (this._stopped) return
    this._stopped = true
    this._media.stop()
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    const mod = loadNative()
    if (mod) { try { mod.stop() } catch {} }
    this.emit('exit', 0, null)
  }
}

// JXA fallback. NX_DEVICERCMDKEYMASK = 1<<4; flagsChanged = 12.
const RIGHT_CMD_MASK = 1 << 4
const JXA_SRC = [
  'ObjC.import("CoreGraphics");',
  'ObjC.import("Foundation");',
  'var mask = ' + RIGHT_CMD_MASK + ';',
  'var types = 1 << 12;',
  'var tap = $.CGEventTapCreate(',
    '$.kCGHIDEventTap, $.kCGHeadInsertEventTap, 0, types,',
    'function(e){',
      'var flags = $.CGEventGetFlags(e);',
      'console.log((flags & mask) !== 0 ? "nico:down" : "nico:up");',
      'return e;',
    '}, 0);',
  'var src = $.CFMachPortCreateRunLoopSource($.kCFAllocatorDefault, tap, 0);',
  'var rl = $.CFRunLoopGetMain();',
  '$.CFRunLoopAddSource(rl, src, $.CFRunLoopModeDefaultMode);',
  '$.CGEventTapEnable(tap, true);',
  'console.log("nico:tap-ready");',
  'while (true) { $.CFRunLoopRunInMode($.CFRunLoopModeDefaultMode, 0.5, false); }',
].join(String.fromCharCode(10))

class JXAHotkey extends EventEmitter {
  constructor() { super(); this.proc = null; this.ready = false }
  start() {
    if (this.proc) return this
    const tmp = join(NICO_DIR, 'hotkey.jxa')
    writeFileSync(tmp, JXA_SRC, { mode: 0o600 })
    const proc = spawn('osascript', ['-l', 'JavaScript', tmp], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.proc = proc
    let buf = ''
    proc.stdout.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf(String.fromCharCode(10))) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line === 'nico:down') this.emit('down')
        else if (line === 'nico:up') this.emit('up')
        else if (line === 'nico:tap-ready') { this.ready = true; this.emit('ready') }
      }
    })
    proc.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) this.emit('stderr', s) })
    proc.on('error', (e) => this.emit('error', e))
    proc.on('exit', (code, signal) => {
      if (!this.ready) this.emit('permission-denied', { code, signal })
      this.proc = null
      this.emit('exit', code, signal)
    })
    return this
  }
  stop() { if (this.proc) { this.proc.kill(); this.proc = null } }
}

export class Hotkey extends EventEmitter {
  constructor() { super(); this._impl = null; this.ready = false }
  start() {
    if (this._impl) return this
    const native = new NativeHotkey()
    this._impl = native
    const onNoNative = () => {
      native.removeAllListeners()
      this._impl = new JXAHotkey()
      this._wire(this._impl)
      this._impl.start()
    }
    this._wire(native)
    native.on('no-native', onNoNative)
    native.start()
    return this
  }
  _wire(impl) {
    impl.on('down', () => this.emit('down'))
    impl.on('up', () => this.emit('up'))
    impl.on('media-toggle-start', () => this.emit('media-toggle-start'))
    impl.on('media-toggle-stop', () => this.emit('media-toggle-stop'))
    impl.on('ready', () => { this.ready = true; this.emit('ready') })
    impl.on('permission-denied', (d) => this.emit('permission-denied', d))
    impl.on('stderr', (s) => this.emit('stderr', s))
    impl.on('error', (e) => this.emit('error', e))
    impl.on('exit', (c, s) => this.emit('exit', c, s))
  }
  stop() { if (this._impl) { this._impl.stop(); this._impl = null } }
}

export function checkAccessibility() {
  try {
    const out = execFileSync('osascript', ['-l', 'JavaScript', '-e',
      'ObjC.import("ApplicationServices");',
      'console.log($.AXIsProcessTrusted() ? "granted" : "denied");'], { encoding: 'utf8', timeout: 5000 })
    return out.trim() === 'granted'
  } catch { return false }
}
