// Nico path resolution — all state lives under ~/.dsh/nico/ (shared with legacy CLI).
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

export const NICO_DIR = process.env.NICO_HOME || join(homedir(), '.dsh', 'nico')
export const RT_DIR = join(NICO_DIR, 'rt')
export const SESSION_ID_FILE = join(NICO_DIR, 'session_id')
// The cwd the session was CREATED under. dsh refuses to adopt a session recorded
// from a different workspace dir, so every dsh invocation must run with this cwd.
export const SESSION_CWD_FILE = join(NICO_DIR, 'session_cwd')
export const ENV_FILE = join(NICO_DIR, '.env')
export const GREETING_FILE = join(NICO_DIR, 'greeting.txt')
export const CRED_FILE = join(homedir(), '.dsh', '.credentials.yaml')

// sherpa-onnx runtime: prefer vendored under ~/.dsh/nico/rt (survives reboot),
// fall back to /tmp/nico_rt (the original extraction target).
const vendored = join(NICO_DIR, 'rt', 'node_modules', 'dsh', 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js')
const tmpRt = join('/tmp/nico_rt', 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js')
export const SHERPA_JS = existsSync(vendored) ? vendored : tmpRt

export const MODEL_DIR = process.env.NICO_MODEL_DIR ||
  join(homedir(), '.dsh', 'speech-to-text', 'sensevoice', 'models', 'sensevoice-onnx')
