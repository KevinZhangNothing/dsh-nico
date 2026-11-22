// Task-progress reducer for the voice bubble.
//
// The headless session's `--json` stream (lib/dsh.mjs normalizeProgress) is a
// list of run events, not a UI model. This module turns it into something the
// bubble can draw: an authoritative todo checklist when the session calls
// todo_write, otherwise a rolling list of tool calls.
//
// Pure and host-free so the reducer is unit-testable (test/progress.test.mjs).
const MAX_TOOL_STEPS = 5
const MAX_TODOS = 8
const MAX_DETAIL = 28

const TOOL_LABELS = {
  bash: '运行命令',
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  glob: '查找文件',
  grep: '搜索内容',
  read_image: '查看图片',
  web_search: '搜索网页',
  web_fetch: '读取网页',
  subagent: '派生子任务',
  subagent_fork: '派生子任务',
  job_output: '等待后台任务',
  job_list: '查看后台任务',
  task: '管理任务',
  skill: '加载技能',
}

const clip = (v, n = MAX_DETAIL) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

const basename = (p) => {
  const s = String(p ?? '').trim()
  return s ? s.split('/').filter(Boolean).pop() || s : ''
}

// One short, human-facing detail for a tool call. Empty when the tool has no
// useful single token (keep the row quiet rather than dumping arguments).
export function toolDetail(tool, input = {}) {
  const i = input || {}
  switch (tool) {
    case 'bash': return clip(i.command ?? i.cmd)
    case 'read':
    case 'write':
    case 'edit':
    case 'read_image': return clip(basename(i.file_path ?? i.path))
    case 'glob': return clip(i.pattern)
    case 'grep': return clip(i.pattern)
    case 'web_search': return clip([].concat(i.queries ?? i.query ?? []).join(' '))
    case 'web_fetch': return clip(i.url)
    default: return ''
  }
}

export function toolLabel(tool, input = {}) {
  const label = TOOL_LABELS[tool] || clip(tool, 18) || '执行'
  const detail = toolDetail(tool, input)
  return detail ? label + ' · ' + detail : label
}

export function createProgress() {
  return { stepNo: 0, todos: null, steps: [] }
}

const normTodoStatus = (s) => {
  const v = String(s ?? '').toLowerCase()
  if (v === 'completed' || v === 'complete' || v === 'done') return 'completed'
  if (v === 'in_progress' || v === 'in-progress' || v === 'active' || v === 'running') return 'in_progress'
  return 'pending'
}

// Apply one normalized progress event. Unknown events return the same object,
// so callers can skip a bubble push when nothing changed.
export function applyProgress(state, ev) {
  const prev = state || createProgress()
  if (!ev || typeof ev !== 'object') return prev
  switch (ev.kind) {
    case 'run-start':
      return createProgress()
    case 'step': {
      const n = Number(ev.step)
      if (!Number.isFinite(n) || n <= 0 || n === prev.stepNo) return prev
      return { ...prev, stepNo: n }
    }
    case 'tool': {
      if (!ev.tool) return prev
      // todo_write is the session's own checklist: it replaces the tool roll-up
      // rather than appearing as another tool row.
      const todos = ev.input?.todos
      if (ev.tool === 'todo_write' && Array.isArray(todos)) {
        const clean = todos
          .filter((t) => t && typeof t === 'object')
          .slice(0, MAX_TODOS)
          .map((t) => ({ content: clip(t.content ?? t.text ?? '', 60), status: normTodoStatus(t.status) }))
        return { ...prev, todos: clean }
      }
      const step = {
        callId: ev.callId || '',
        label: toolLabel(ev.tool, ev.input),
        status: 'running',
      }
      return { ...prev, steps: [...prev.steps, step].slice(-MAX_TOOL_STEPS) }
    }
    case 'tool-result': {
      if (!ev.callId) return prev
      let touched = false
      const steps = prev.steps.map((s) => {
        if (s.callId !== ev.callId) return s
        touched = true
        return { ...s, status: ev.status === 'error' ? 'error' : 'completed' }
      })
      return touched ? { ...prev, steps } : prev
    }
    default:
      return prev
  }
}

// Bubble-facing view: header state + task text + concrete action rows + a hint
// naming the action in progress. No ordinals or ratios — the list is what was
// done / is being done, not "step 1 / step 2".
export function progressView(state, text = '') {
  const s = state || createProgress()
  const plan = Boolean(s.todos?.length)
  const steps = plan
    ? s.todos.map((t) => ({ label: t.content || '（未命名动作）', status: t.status }))
    : s.steps.map((t) => ({ label: t.label, status: t.status }))
  const active = steps.find((t) => t.status === 'running' || t.status === 'in_progress')
  let hint = '执行中…'
  if (plan) {
    const current = steps.find((t) => t.status === 'in_progress')
    const next = steps.find((t) => t.status !== 'completed')
    hint = current ? '正在做：' + clip(current.label, 30)
      : next ? '下一步：' + clip(next.label, 28)
      : '已完成'
  } else if (active) {
    hint = '正在做：' + clip(active.label, 30)
  }
  return { state: 'working', text, plan, steps, hint }
}
