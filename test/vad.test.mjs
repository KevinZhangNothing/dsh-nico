import test from 'node:test'
import assert from 'node:assert/strict'
import { sampleStats, trimSilence } from '../lib/vad.mjs'

// 16k mono helpers: one second of silence, then tone, then silence.
const SR = 16000
function silence(sec) {
  return new Float32Array(Math.round(sec * SR))
}
function tone(sec, amp = 0.3) {
  const n = Math.round(sec * SR)
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) s[i] = amp * Math.sin(2 * Math.PI * 440 * (i / SR))
  return s
}
function concat(...parts) {
  const total = parts.reduce((a, p) => a + p.length, 0)
  const out = new Float32Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

test('sampleStats reports duration, rms and peak', () => {
  const s = concat(silence(0.5), tone(1), silence(0.5))
  const st = sampleStats(s, SR)
  assert.ok(Math.abs(st.durationSec - 2) < 0.01, 'duration ' + st.durationSec)
  assert.ok(st.rms > 0 && st.rms < 0.3, 'rms ' + st.rms)
  assert.ok(st.peak > 0.25 && st.peak <= 0.31, 'peak ' + st.peak)
  assert.deepEqual(sampleStats(new Float32Array(0), SR), { durationSec: 0, rms: 0, peak: 0 })
})

test('trimSilence cuts leading/trailing quiet and keeps speech', () => {
  const s = concat(silence(1), tone(1), silence(1))
  const out = trimSilence(s, { sampleRate: SR, threshold: 0.012 })
  // speech + padSec padding on both sides, not the 3 s original
  assert.ok(out.length > SR * 0.9 && out.length < SR * 1.5, 'kept ' + out.length + ' samples')
})

test('trimSilence returns empty for an all-quiet press (misfire gate)', () => {
  assert.equal(trimSilence(silence(2), { sampleRate: SR }).length, 0)
  assert.equal(trimSilence(new Float32Array(0), { sampleRate: SR }).length, 0)
  // A realistic accidental press: tiny fan/room noise below threshold.
  const noise = new Float32Array(SR)
  for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() - 0.5) * 0.004
  assert.equal(trimSilence(noise, { sampleRate: SR }).length, 0)
})

test('trimSilence keeps quiet-but-real speech above threshold', () => {
  // 0.05 amplitude tone: quiet voice, still 4x above the 0.012 default gate.
  const s = concat(tone(0.4, 0.05))
  const out = trimSilence(s, { sampleRate: SR })
  assert.ok(out.length >= SR * 0.4, 'kept ' + out.length + ' samples')
})

test('threshold is overridable via option (NICO_VAD_THRESHOLD wiring)', () => {
  const noise = new Float32Array(SR)
  for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() - 0.5) * 0.004
  // A threshold of 0 would keep the noise — env override must reach the option.
  const out = trimSilence(noise, { sampleRate: SR, threshold: 0 })
  assert.ok(out.length > 0)
})
