// 气泡窗渲染层：状态头/正文/hint。宿主（bubble.swift）只调 window.__nico.setState；
// 本页只消费 s.state / s.text / s.hint，背景毛玻璃由原生层提供，这里不画任何
// 背景。人物/口型/motion 在 model.js。HEAD 状态词表：与 model 同目录的
// bubble.js 同步维护——两个小文件各自独立，不引入共享模块加载复杂度。
// 尺寸自适应：setState 更新文字后量出内容宽高，经 nicoSize message 回传给
// Swift 缩放气泡窗。无最小值：短文案贴内容自然大小；只夹上限 MAX_W/MAX_H
// （Swift 侧仅兜底防 0×0）。
const HEAD = {
  listening: ['●',  'Listening'],           thinking: ['◌', 'Thinking'],
  start:     ['⏵', 'Starting the task…'],   speaking: ['〰', 'Speaking'],
  end:       ['✓', 'Done'],                 fail:     ['!', 'Failed'],
}
const MAX_W = 560, MAX_H = 420
const $ = (id) => document.getElementById(id)

// 先 max-content 量自然宽，夹到 ≤MAX_W 定宽，再量换行后的高（#text 已被
// line-clamp 截到 4 行），夹到 ≤MAX_H。
function fitSize() {
  const el = $('bubble')
  el.style.width = 'max-content'
  const w = Math.min(el.offsetWidth, MAX_W)
  el.style.width = w + 'px'
  const h = Math.min(el.offsetHeight, MAX_H)
  window.webkit?.messageHandlers?.nicoSize?.postMessage({ w: w, h: h })
}

window.__nico = {
  setState(s) {
    // idle：人物常驻待机，web 内容置透明；整窗显隐由 Swift 侧负责（idle 时
    // bubblePanel 不上屏/在屏则 orderOut，防空毛玻璃块残留）。
    if (s.state === 'idle') { $('bubble').style.opacity = 0; return }
    const [ico, label] = HEAD[s.state] ?? HEAD.listening
    $('bubble').style.opacity = 1
    $('hico').textContent = ico; $('hlabel').textContent = label
    $('text').textContent = s.text ?? ''; $('hint').textContent = s.hint ?? ''
    fitSize()
  },
}
