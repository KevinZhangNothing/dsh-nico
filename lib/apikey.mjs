// Load DEEPSEEK_API_KEY from ~/.dsh/.credentials.yaml (records section) without a YAML dep.
import { readFileSync, existsSync } from 'node:fs'
import { NICO_DIR, CRED_FILE, ENV_FILE } from './paths.mjs'

export function loadApiKey() {
  // 1. already in env?
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  // 2. .env file from previous setup
  if (existsSync(ENV_FILE)) {
    try {
      const env = readFileSync(ENV_FILE, 'utf8')
      const m = env.match(/DEEPSEEK_API_KEY=(.+)/)
      if (m && m[1].trim()) {
        const k = m[1].trim().replace(/^export /, '')
        process.env.DEEPSEEK_API_KEY = k
        return k
      }
    } catch { /* fall through */ }
  }
  // 3. parse .credentials.yaml  (simple `  DEEPSEEK_API_KEY: sk-...` under records:)
  if (existsSync(CRED_FILE)) {
    try {
      const yaml = readFileSync(CRED_FILE, 'utf8')
      const m = yaml.match(/DEEPSEEK_API_KEY:\s*(.+)/)
      if (m && m[1].trim()) {
        const k = m[1].trim().replace(/^['"]/, '').replace(/['"]$/, '')
        process.env.DEEPSEEK_API_KEY = k
        return k
      }
    } catch { /* fall through */ }
  }
  return null
}
