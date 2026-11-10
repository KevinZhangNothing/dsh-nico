// CosyVoice2 local deployment: clone the repo, build a venv, install the
// repo requirements, fetch the CosyVoice2-0.5B weights from ModelScope, then
// launch the OpenAI-compatible server detached. Every step is idempotent/
// resumable so a failed run can just be retried.
// Invoked DETACHED by lib/tts-setup.mjs; progress goes to the status/log
// files (COSY_STATUS / COSY_LOG_FILE env) and stdout is unused.
//
// Optional env: COSY_DIR (default ~/.dsh/nico/cosyvoice), PIP_INDEX_URL.
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const COSY_DIR = process.env.COSY_DIR || join(homedir(), '.dsh', 'nico', 'cosyvoice')
const SRC = join(COSY_DIR, 'src')
const VENV = join(COSY_DIR, 'venv')
const MODEL = join(COSY_DIR, 'models', 'CosyVoice2-0.5B')
const REPO = 'https://github.com/FunAudioLLM/CosyVoice.git'
const STATUS_FILE = process.env.COSY_STATUS || join(COSY_DIR, 'deploy-status.json')
const LOG_FILE = process.env.COSY_LOG_FILE || join(COSY_DIR, 'deploy.log')
const SERVE_PORT = (() => {
  const i = process.argv.indexOf('--serve')
  return i > 0 ? process.argv[i + 1] : null
})()

function note(state, msg) {
  try {
    writeFileSync(STATUS_FILE, JSON.stringify({ state, detail: msg, at: new Date().toISOString() }, null, 2) + '\n')
  } catch {}
}
function log(msg) {
  try { appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + msg + '\n') } catch {}
  console.error(msg)
}

function step(n, msg) { log('[deploy] [' + n + '] ' + msg) }

function run(cmd, args, label) {
  log('[deploy] ' + label + ': ' + cmd + ' ' + args.join(' '))
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.status !== 0) {
    log('[deploy] ' + label + ' 失败（exit=' + r.status + '）')
    note('failed', label + ' 失败（exit=' + r.status + '），修复后重试即可断点续跑')
    process.exit(2)
  }
}

function main() {
  mkdirSync(COSY_DIR, { recursive: true })
  note('running', '部署进行中')

  // 0. prerequisites
  for (const bin of ['git', 'python3']) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' })
    if (r.status !== 0) { console.error('[deploy] 缺少 ' + bin + '，请先安装（brew install ' + (bin === 'git' ? 'git' : 'python') + '）'); process.exit(2) }
  }
  step('0/5', 'git / python3 可用')

  // 1. repo checkout (shallow)
  if (!existsSync(join(SRC, 'cosyvoice'))) {
    step('1/5', '克隆 CosyVoice 源码（shallow）')
    mkdirSync(SRC, { recursive: true })
    run('git', ['clone', '--depth', '1', REPO, SRC], 'git clone')
  } else {
    step('1/5', '源码已存在，跳过克隆')
  }

  // 2. venv
  if (!existsSync(join(VENV, 'bin', 'python'))) {
    step('2/5', '创建 venv')
    run('python3', ['-m', 'venv', VENV], 'venv')
  } else {
    step('2/5', 'venv 已存在，跳过')
  }

  // 3. python deps (torch 2.3.1 arm64 wheel + onnxruntime darwin；linux 专属依赖被 requirements 条件排除)
  const pip = join(VENV, 'bin', 'pip')
  step('3/5', '安装 Python 依赖（torch 等，约 2GB，最慢一步）')
  run(pip, ['install', '--upgrade', 'pip'], 'pip upgrade')
  run(pip, ['install', '-r', join(SRC, 'requirements.txt')], 'pip requirements')

  // 4. weights via ModelScope (~2.5GB)
  if (existsSync(join(MODEL, 'cosyvoice2.yaml'))) {
    step('4/5', '模型权重已存在，跳过下载')
  } else {
    step('4/5', '下载 CosyVoice2-0.5B 权重（ModelScope，约 2.5GB）')
    run(pip, ['install', 'modelscope==1.20.0'], 'pip modelscope')
    run(join(VENV, 'bin', 'python'), ['-c',
      'from modelscope import snapshot_download; snapshot_download("iic/CosyVoice2-0.5B", local_dir="' + MODEL + '")',
    ], 'model download')
  }

  // 5. marker + summary
  step('5/5', '写入部署清单')
  writeFileSync(join(COSY_DIR, 'deploy.json'), JSON.stringify({ src: SRC, venv: VENV, model: MODEL, deployedAt: new Date().toISOString() }, null, 2) + '\n')
  log('[deploy] 部署完成：' + COSY_DIR)

  // 6. chain the server launch (detached, outlives this script)
  const SERVER_PY = process.env.NICO_SERVER_PY
  if (SERVE_PORT && SERVER_PY) {
    note('running', '启动服务 port=' + SERVE_PORT)
    log('[deploy] 启动服务（模型加载约 30–90s）…')
    const child = spawn(join(VENV, 'bin', 'python'), [SERVER_PY, '--src', SRC, '--model-dir', MODEL, '--port', SERVE_PORT], {
      detached: true, stdio: 'ignore',
      env: { ...process.env },
    })
    child.unref()
    log('[deploy] 服务进程 pid=' + child.pid + '，就绪后 GUI 检测会变绿')
    note('done', '部署完成，服务启动中 pid=' + child.pid)
  } else {
    note('done', '部署完成')
  }
}

main()
