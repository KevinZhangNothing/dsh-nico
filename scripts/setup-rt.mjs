// Extract sherpa-onnx-node + sherpa-onnx-darwin-arm64 from the DSH app.asar
// into ~/.dsh/nico/rt/node_modules, so the plugin's STT survives reboot.
// asar layout: u32@0=4, u32@4, u32@8, u32@12=jsonLen; json@16; dataStart=16+jsonLen+2.
// 'unpacked' entries live in app.asar.unpacked/<same path>.
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const APP_CANDIDATES = [
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
  join(homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'app.asar'),
]
const APP = APP_CANDIDATES.find((p) => existsSync(p)) || APP_CANDIDATES[0]
const UNPACKED = APP + '.unpacked'
const DEST = join(homedir(), '.dsh', 'nico', 'rt', 'node_modules')

function sha256(buf) { return createHash('sha256').update(buf).digest('hex') }

function main() {
  if (!existsSync(APP)) { console.error('app.asar not found at ' + APP); process.exit(1) }
  const buf = readFileSync(APP)
  const jsonLen = buf.readUInt32LE(12)
  const dataStart = 16 + jsonLen + 2
  const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'))

  // Walk the header tree, collecting sherpa-onnx* file entries under dsh/node_modules.
  const out = []
  function walk(node, prefix) {
    if (!node || typeof node !== 'object') return
    if (node.files) {
      for (const [k, v] of Object.entries(node.files)) {
        const p = prefix + '/' + k
        if (v.files) walk(v, p)
        else {
          const name = k
          if (/sherpa-onnx/.test(p) && v.size != null) {
            out.push({ path: p, size: v.size, offset: v.offset, unpacked: !!v.unpacked, hash: v.integrity && v.integrity.hash })
          }
        }
      }
    }
  }
  walk(header, '')
  console.error('found ' + out.length + ' sherpa-onnx files')

  let copied = 0, verified = 0, failed = 0
  for (const f of out) {
    let content
    if (f.unpacked) {
      const src = join(UNPACKED, f.path)
      if (!existsSync(src)) { console.error('MISSING unpacked: ' + src); failed++; continue }
      content = readFileSync(src)
    } else if (f.offset != null) {
      content = buf.subarray(dataStart + parseInt(f.offset, 10), dataStart + parseInt(f.offset, 10) + f.size)
    } else {
      console.error('SKIP (no offset/unpacked): ' + f.path); failed++; continue
    }
    if (f.hash) {
      const h = sha256(content)
      if (h !== f.hash) { console.error('HASH MISMATCH: ' + f.path); failed++; continue }
      verified++
    }
    const dest = join(DEST, f.path)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, content)
    copied++
  }
  console.log('copied=' + copied + ' verified=' + verified + ' failed=' + failed)
  if (failed > 0) process.exit(2)
  console.log('sherpa runtime ready at ' + DEST)
}

main()
