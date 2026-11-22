// lib/overlay-proto.mjs
// Overlay 状态机：voice 事件 → stdin 协议载荷（给 native/bubble 的 WKWebView）。
// 七态：listening / thinking / working / start / speaking / end / fail。
// working 额外携带 steps（任务分步进度，来自 lib/progress.mjs）。

const MOTION = {
  listening: { motion: 'Idle',  exp: 'f01_normal' },
  thinking:  { motion: null,    exp: 'f08_sleepy' },
  working:   { motion: 'Idle',  exp: 'f08_sleepy' },
  start:     { motion: 'Nod',   exp: 'f05_surprised' },
  speaking:  { motion: null,    exp: 'f02_smile' },
  end:       { motion: 'Bow',   exp: 'f02_smile' },
  fail:      { motion: 'Shake', exp: 'f03_angry' },
}

export function eventToState(event, p = {}) {
  switch (event) {
    case 'rec-start':  return { state: 'listening', hint: 'Release to send · Press Esc to cancel' }
    case 'transcript': return p.text ? { state: 'thinking', text: p.text } : null
    // 任务执行中的分步进度。text 仍是用户说出的任务，steps 由 progressView 生成；
    // 空数组也照发，气泡据此清掉上一条任务的步骤。
    case 'progress':   return { state: 'working', text: p.text, plan: p.plan === true, steps: Array.isArray(p.steps) ? p.steps : [], hint: p.hint }
    case 'reply-ok':   return { state: 'start', text: p.reply, hint: 'Reply ready · preparing speech…' }
    case 'speak':      return { state: 'speaking', text: p.reply }
    case 'tts-playing': return { state: 'speaking', text: p.reply }   // audio actually audible
    case 'tts-done':   return { state: 'end', text: p.reply }
    case 'fail':       return { state: 'fail', text: p.text || '录音失败' }
    default:           return null
  }
}

export function decorate(s) {
  return s ? { ...s, ...(MOTION[s.state] ?? MOTION.listening) } : null
}

// 旧 {"op":"show","text"} 的 emoji 前缀 → 新状态（兼容期用，接线完成后可删）。
export function legacyShow(text = '') {
  // 按码点剥前导 emoji + 空白（⚠️ 是 U+26A0 U+FE0F 两个码点，slice(2) 会留空格）
  const strip = (t) => t.replace(/^\S+\s*/, '')
  if (text.startsWith('🎙')) return { state: 'listening' }
  if (text.startsWith('📝')) return { state: 'thinking', text: strip(text) }
  if (text.startsWith('✅')) return { state: 'end', text: strip(text) }
  if (text.startsWith('⚠️')) return { state: 'fail', text: strip(text) }
  return { state: 'listening', text }
}
