// SenseVoice STT via sherpa-onnx (ESM wrapper).
// Model: SenseVoice (ONNX int8), 16k mono. Fully local.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { SHERPA_JS, MODEL_DIR } from './paths.mjs'

const require = createRequire(import.meta.url)
const sherpa = require(SHERPA_JS)

let recognizer = null

function getRecognizer() {
  if (recognizer) return recognizer
  const cfg = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: join(MODEL_DIR, 'model.int8.onnx'),
        language: 'auto',
        useInverseTextNormalization: 1,
      },
      tokens: join(MODEL_DIR, 'tokens.txt'),
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
    },
  }
  recognizer = new sherpa.OfflineRecognizer(cfg)
  return recognizer
}

// sherpa.readWave() uses an external native buffer rejected by the current
// Node/Electron runtime. Decode the RIFF/WAVE payload in JS instead; recorder
// output is PCM16, with float32 accepted for CLI compatibility.
function readWav(wavPath) {
  const buf = readFileSync(wavPath)
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let fmt = null
  let data = null
  for (let offset = 12; offset + 8 <= buf.length;) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + size > buf.length) break
    if (id === 'fmt ') fmt = {
      format: buf.readUInt16LE(start), channels: buf.readUInt16LE(start + 2),
      sampleRate: buf.readUInt32LE(start + 4), bits: buf.readUInt16LE(start + 14),
    }
    else if (id === 'data') data = { start, size }
    offset = start + size + (size & 1)
  }
  if (!fmt || !data) throw new Error('WAV fmt/data chunk missing')
  const width = fmt.bits / 8
  const frames = Math.floor(data.size / (width * fmt.channels))
  const samples = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    for (let channel = 0; channel < fmt.channels; channel++) {
      const at = data.start + (frame * fmt.channels + channel) * width
      if (fmt.format === 1 && fmt.bits === 16) sum += buf.readInt16LE(at) / 32768
      else if (fmt.format === 3 && fmt.bits === 32) sum += buf.readFloatLE(at)
      else throw new Error('unsupported WAV encoding: format=' + fmt.format + ' bits=' + fmt.bits)
    }
    samples[frame] = sum / fmt.channels
  }
  return { sampleRate: fmt.sampleRate, samples }
}

// Recognize a WAV file. Returns { text, raw } for callers that need the raw result.
export function recognizeWav(wavPath) {
  const rec = getRecognizer()
  const wave = readWav(wavPath)
  const stream = rec.createStream()
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples })
  rec.decode(stream)
  const r = rec.getResult(stream)
  return { text: (r.text || '').trim(), raw: r }
}


// ── routed transcription ───────────────────────────────────────────────────
// One entrypoint the voice flow calls. Honors nico's STT selection:
//   engine 'local' (default) → SenseVoiceSmall INT8 on disk, fully offline.
//   engine 'cloud'           → the provider ASR model (e.g. qwen3-asr) over
//                              the nothing-llm OpenAI-compatible endpoint.
// A cloud failure falls back to local so a hold-to-talk never goes dead.
let sttSelection = null
export function setSttSelection(sel) { sttSelection = sel || null }

// The selected reasoning provider (from nico settings), injected by the cordis
// entrypoint. Used as a fallback cloud-ASR provider when the STT selection has
// no explicit cloudProvider, so the endpoint is read from the host's own
// model config rather than a hardcoded base URL.
let sttReasoningProvider = null
export function setSttReasoningProvider(p) { sttReasoningProvider = p || null }
export async function transcribe(wavPath, selection) {
  const sel = selection || sttSelection || { engine: 'local', model: null }
  if (sel.engine === 'cloud' && sel.model) {
    try {
      const { transcribeCloud } = await import('./cloud-stt.mjs')
      const text = await transcribeCloud(wavPath, sel.model, {
        cloudProvider: sel.cloudProvider || null,
        reasoningProvider: sttReasoningProvider,
      })
      if (text && text.trim()) return { text: text.trim(), engine: 'cloud', model: sel.model }
    } catch (e) {
      // fall through to local on any cloud failure
    }
  }
  return { text: recognizeWav(wavPath).text, engine: 'local', model: 'sensevoice-small-int8' }
}
