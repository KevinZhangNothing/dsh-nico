// postinstall: 确保原生右⌘热键模块存在。
// 已有编译产物 → 跳过；缺失 → 尝试 node-gyp 编译；失败 → 不阻断安装
// （lib/hotkey.mjs 会自动回退 JXA/osascript 后端）。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nativeDir = join(root, 'native')
const buildDir = join(nativeDir, 'build')
const candidates = ['Release', 'Debug'].map((d) => join(buildDir, d, 'hotkey_tap.node'))
const existing = candidates.find((p) => existsSync(p))

if (existing) {
  process.exit(0)
}

if (!existsSync(join(nativeDir, 'binding.gyp'))) {
  console.warn('[dsh-nico] 未找到 native/binding.gyp，跳过原生热键编译（JXA 回退可用）')
  process.exit(0)
}

const r = spawnSync('npx', ['--yes', 'node-gyp', 'rebuild', '--build-output', buildDir], {
  cwd: nativeDir,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})

if (r.status === 0) {
  console.log('[dsh-nico] 原生热键模块编译完成')
  process.exit(0)
}

const tail = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')
console.warn('[dsh-nico] 原生热键模块编译失败（热键回退 JXA 后端）：' + tail.slice(0, 300))
process.exit(0)
