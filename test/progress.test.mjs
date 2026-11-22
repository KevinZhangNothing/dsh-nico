import test from 'node:test'
import assert from 'node:assert/strict'
import { createProgress, applyProgress, progressView, toolLabel } from '../lib/progress.mjs'
import { normalizeProgress } from '../lib/dsh.mjs'

const tool = (callId, name, input = {}) => ({ kind: 'tool', callId, tool: name, input })
const result = (callId, status = 'completed') => ({ kind: 'tool-result', callId, status })

test('tool call becomes a running row with a friendly label', () => {
  const s = applyProgress(createProgress(), tool('c1', 'bash', { command: 'echo hi' }))
  assert.equal(s.steps.length, 1)
  assert.equal(s.steps[0].status, 'running')
  assert.equal(s.steps[0].label, '运行命令 · echo hi')
  assert.equal(toolLabel('read', { file_path: '/tmp/a/b.mjs' }), '读取文件 · b.mjs')
})

test('tool result closes the matching row only', () => {
  let s = applyProgress(createProgress(), tool('c1', 'read', { file_path: '/x/a.md' }))
  s = applyProgress(s, tool('c2', 'grep', { pattern: 'needle' }))
  s = applyProgress(s, result('c1'))
  assert.equal(s.steps.find((x) => x.callId === 'c1').status, 'completed')
  assert.equal(s.steps.find((x) => x.callId === 'c2').status, 'running')
  assert.equal(applyProgress(s, result('nope')), s, 'unknown callId is a no-op')
  assert.equal(applyProgress(s, result('c2', 'error')).steps[1].status, 'error')
})

test('todo_write replaces the tool roll-up with the checklist', () => {
  let s = applyProgress(createProgress(), tool('c1', 'bash', { command: 'ls' }))
  s = applyProgress(s, tool('c2', 'todo_write', {
    todos: [
      { content: '读取代码', status: 'completed' },
      { content: '修改实现', status: 'in_progress' },
      { content: '跑测试', status: 'pending' },
    ],
  }))
  assert.equal(s.todos.length, 3)
  assert.equal(s.steps.length, 1, 'todo_write is not a tool row')
  const v = progressView(s, '帮我修个 bug')
  assert.equal(v.state, 'working')
  assert.equal(v.text, '帮我修个 bug')
  assert.equal(v.plan, true, 'todo list is the action checklist')
  assert.deepEqual(v.steps.map((x) => x.status), ['completed', 'in_progress', 'pending'])
  assert.equal(v.hint, '正在做：修改实现', 'names the action, not an ordinal')
})

test('plan hint falls back to the next action, then done', () => {
  let s = applyProgress(createProgress(), tool('c', 'todo_write', {
    todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
      { content: 'c', status: 'pending' },
    ],
  }))
  assert.equal(progressView(s, '').hint, '下一步：b')
  s = applyProgress(s, tool('d', 'todo_write', {
    todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'completed' },
    ],
  }))
  assert.equal(progressView(s, '').hint, '已完成')
})

test('todo rows are capped and unknown statuses become pending', () => {
  const todos = Array.from({ length: 12 }, (_, i) => ({ content: 's' + i, status: i === 0 ? 'weird' : 'completed' }))
  const s = applyProgress(createProgress(), tool('c', 'todo_write', { todos }))
  assert.equal(s.todos.length, 8)
  assert.equal(s.todos[0].status, 'pending')
})

test('run-start resets the rows; step events only advance stepNo', () => {
  let s = applyProgress(createProgress(), tool('c1', 'bash', { command: 'x' }))
  s = applyProgress(s, { kind: 'step', step: 3 })
  assert.equal(s.stepNo, 3)
  assert.equal(s.steps.length, 1)
  const fresh = applyProgress(s, { kind: 'run-start' })
  assert.equal(fresh.steps.length, 0)
  assert.equal(fresh.stepNo, 0)
  assert.equal(fresh.todos, null)
})

test('tool rows keep only the most recent five', () => {
  let s = createProgress()
  for (let i = 0; i < 8; i++) s = applyProgress(s, tool('c' + i, 'bash', { command: 'cmd' + i }))
  assert.equal(s.steps.length, 5)
  assert.equal(s.steps[0].callId, 'c3')
  assert.equal(s.steps[4].callId, 'c7')
})

test('empty progress view stays neutral; step counters do not surface', () => {
  const v = progressView(createProgress(), '')
  assert.equal(v.state, 'working')
  assert.equal(v.plan, false)
  assert.deepEqual(v.steps, [])
  assert.equal(v.hint, '执行中…')
  const stepped = applyProgress(createProgress(), { kind: 'step', step: 2 })
  assert.equal(progressView(stepped, 'x').hint, '执行中…', 'no "step N" hint')
})

test('normalizeProgress maps only drawable run events', () => {
  assert.deepEqual(normalizeProgress({ type: 'status', phase: 'step_start', step: 2 }), { kind: 'step', step: 2 })
  assert.equal(normalizeProgress({ type: 'status', phase: 'turn_start', turn: 1 }), null)
  assert.equal(normalizeProgress({ type: 'thinking', text: 'x' }), null)
  assert.equal(normalizeProgress({ type: 'text', text: 'x' }), null)
  assert.deepEqual(
    normalizeProgress({ type: 'tool_call', callId: 'c', tool: 'bash', input: { command: 'ls' } }),
    { kind: 'tool', callId: 'c', tool: 'bash', input: { command: 'ls' } },
  )
  assert.deepEqual(
    normalizeProgress({ type: 'tool_result', callId: 'c', status: 'completed' }),
    { kind: 'tool-result', callId: 'c', status: 'completed' },
  )
  assert.equal(normalizeProgress(null), null)
})
