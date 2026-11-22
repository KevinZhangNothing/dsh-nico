// Energy gate + silence trim on PCM samples — the endpointing basics every
// leading dictation tool ships: an accidental press (no speech) must not reach
// STT, and leading/trailing quiet must be cut before decode or SenseVoice
// hallucinates characters on pure hiss. Pure functions, no native deps.

const FRAME_SEC = 0.02   // 20 ms analysis frames, standard VAD granularity

function frameRms(samples, start, frame) {
  let sum = 0
  for (let j = start; j < start + frame; j++) sum += samples[j] * samples[j]
  return Math.sqrt(sum / frame)
}

// Overall stats for gating decisions: duration, whole-buffer RMS and peak.
export function sampleStats(samples, sampleRate = 16000) {
  if (!samples || !samples.length) return { durationSec: 0, rms: 0, peak: 0 }
  let sum = 0
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]
    sum += v * v
    const a = v < 0 ? -v : v
    if (a > peak) peak = a
  }
  return {
    durationSec: samples.length / sampleRate,
    rms: Math.sqrt(sum / samples.length),
    peak,
  }
}

// Cut leading/trailing frames quieter than threshold (absolute RMS), keeping
// padSec of padding around the detected speech span. All-quiet input returns
// an empty buffer so callers can skip STT entirely.
export function trimSilence(samples, { sampleRate = 16000, threshold = 0.012, padSec = 0.12 } = {}) {
  if (!samples || !samples.length) return new Float32Array(0)
  const frame = Math.max(1, Math.round(sampleRate * FRAME_SEC))
  let first = -1
  let last = -1
  for (let i = 0; i + frame <= samples.length; i += frame) {
    if (frameRms(samples, i, frame) >= threshold) {
      if (first < 0) first = i
      last = i + frame
    }
  }
  if (first < 0) return new Float32Array(0)
  const pad = Math.round(sampleRate * padSec)
  return samples.slice(Math.max(0, first - pad), Math.min(samples.length, last + pad))
}

// Endpointing for hands-free mode, driven by ffmpeg silencedetect stderr lines
// (feed one line per call). ffmpeg fires silence_start once a silence window
// has lasted the full -d duration, and silence_end when sound returns.
// Semantics: leading silence must not endpoint (nobody spoke yet) — only the
// FIRST silence window after real speech ends the utterance. One endpoint per
// recording; the caller stops the capture when it fires.
export function createSilenceWatcher({ onEndpoint } = {}) {
  let sawSpeech = false
  let fired = false
  return {
    feed(line) {
      const s = String(line)
      if (/silence_end/.test(s)) { sawSpeech = true; return }
      if (/silence_start/.test(s) && sawSpeech && !fired) {
        fired = true
        onEndpoint?.()
      }
    },
    get sawSpeech() { return sawSpeech },
    get fired() { return fired },
  }
}
