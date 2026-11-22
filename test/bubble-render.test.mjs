import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'native/overlay/bubble.js'), 'utf8')

// Minimal DOM shim: enough to exercise bubble.js's real render path without a
// browser (WKWebView renders the same DOM/CSS in production).
function el(tag = 'div') {
  return {
    tagName: tag,
    children: [],
    style: {},
    className: '',
    _text: '',
    get textContent() { return this._text },
    set textContent(v) { this._text = String(v); this.children.length = 0 },
    append(...nodes) { this.children.push(...nodes) },
    offsetWidth: 200,
    offsetHeight: 140,
  }
}

function load() {
  const nodes = {
    bubble: el(), hico: el(), hlabel: el(), text: el(), steps: el(), hint: el(),
  }
  const sizes = []
  const ctx = {
    document: { getElementById: (id) => nodes[id], createElement: el },
    window: { webkit: { messageHandlers: { nicoSize: { postMessage: (m) => sizes.push(m) } } } },
    JSON,
  }
  vm.createContext(ctx)
  vm.runInContext(source, ctx)
  return { api: ctx.window.__nico, nodes, sizes }
}

test('working state renders the step rows and measures once', () => {
  const { api, nodes, sizes } = load()
  const state = {
    state: 'working',
    text: '整理桌面',
    plan: true,
    hint: '正在做：运行命令 · ls',
    steps: [
      { label: '读取文件 · a.mjs', status: 'completed' },
      { label: '运行命令 · ls', status: 'running' },
      { label: '跑测试', status: 'pending' },
    ],
  }
  api.setState(state)
  assert.equal(nodes.hlabel.textContent, 'Working')
  assert.equal(nodes.text.textContent, '整理桌面')
  assert.equal(nodes.steps.style.display, 'block')
  assert.equal(nodes.steps.children.length, 3)
  // Rows are the actions themselves, with only a status icon.
  assert.equal(nodes.steps.children[0].children[0].textContent, '✓')
  assert.equal(nodes.steps.children[0].children[1].textContent, '读取文件 · a.mjs')
  assert.equal(nodes.steps.children[1].children[0].textContent, '●')
  assert.equal(nodes.steps.children[1].children[1].textContent, '运行命令 · ls')
  assert.equal(nodes.steps.children[2].children[0].textContent, '○')
  assert.equal(nodes.steps.children[2].children[1].textContent, '跑测试')
  assert.equal(sizes.length, 1)
  // Same payload again (step_start/step_end churn) must not re-measure.
  api.setState(state)
  assert.equal(sizes.length, 1)
})

test('non-working states clear stale rows; idle hides the bubble', () => {
  const { api, nodes } = load()
  api.setState({ state: 'working', text: 'x', steps: [{ label: 'a', status: 'running' }] })
  assert.equal(nodes.steps.children.length, 1)
  api.setState({ state: 'end', text: '完成' })
  assert.equal(nodes.hlabel.textContent, 'Done')
  assert.equal(nodes.steps.children.length, 0)
  assert.equal(nodes.steps.style.display, 'none')
  api.setState({ state: 'working', text: 'x', steps: [{ label: 'a', status: 'running' }] })
  api.setState({ state: 'idle' })
  assert.equal(nodes.bubble.style.opacity, 0)
  assert.equal(nodes.steps.children.length, 0)
})

test('step rows are capped and labels stay text (no HTML)', () => {
  const { api, nodes } = load()
  const steps = Array.from({ length: 9 }, (_, i) => ({ label: '<b>' + i + '</b>', status: 'pending' }))
  api.setState({ state: 'working', text: 'x', steps })
  assert.equal(nodes.steps.children.length, 6)
  assert.equal(nodes.steps.children[0].children[1].textContent, '<b>0</b>')
})
