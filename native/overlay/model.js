// 人物窗渲染层：pixi + Live2D 人物 + 口型。宿主（bubble.swift）只调
// window.__nico.setState；本页只消费 s.motion / s.exp / s.state（speaking 口型）。
// 文字/提示在 bubble.js。依赖 pixi-live2d-display 0.4.0（UMD，挂到 PIXI.live2d）。
// 口型与 motion/exp 去重逻辑：与 bubble 同目录的 model.js 同步维护——两个小文件
// 各自独立，不引入共享模块加载复杂度。
// 诊断：每个关键步骤经 nicoLog 回传宿主 stderr（init 各步、失败原因、模型尺寸）。
const MODEL_URL = '../live2d/model3.json'
// 身体跟随头部的跟随系数：素材构建器把头/身网格在 y≈-0.5 处做成平齐拼接（搭接仅
// ~0.002），头部 Angle 满档摆动时脖子接缝会裂开露背景。让 BodyAngle 按
// BODY_FOLLOW_K 跟随 Angle 可把接缝错位压回搭接量以内。AngleX ±30 时叠加量为
// ±24，仍在 BodyAngleX 的 -30~30 值域内。
const BODY_FOLLOW_K = 0.8
const log = (m) => { try { window.webkit?.messageHandlers?.nicoLog?.postMessage(m) } catch {} ; console.log(m) }
log('core=' + (typeof Live2DCubismCore))
// 诊断补丁：XHR 失败/非 200、未处理 rejection、全局错误都上报。
const _open = XMLHttpRequest.prototype.open
XMLHttpRequest.prototype.open = function (m, u) {
  this.addEventListener('error', () => log('XHR error: ' + m + ' ' + u))
  this.addEventListener('load', () => { if (this.status && this.status >= 400) log('XHR ' + this.status + ': ' + u) })
  return _open.call(this, m, u)
}
addEventListener('unhandledrejection', (ev) => log('unhandled: ' + (ev.reason?.stack || ev.reason?.message || String(ev.reason))))
window.onerror = (msg, src, l, c) => log('onerror: ' + msg + ' @' + src + ':' + l + ':' + c)
log('model.js: scripts loaded PIXI=' + (typeof PIXI !== 'undefined') +
    ' live2d=' + (typeof PIXI !== 'undefined' && PIXI.live2d ? 'yes' : 'no'))

// 不用 resizeTo：webview 首帧前 innerWidth/Height 为 0 且之后未必有 resize 事件，
// canvas 会停在 0x0。fit() 里显式 resize（见下）。
// 锁定 WebGL1：pixi v6 已移除 PREFER_WEBGL_2（默认 WebGL2），而
// pixi-live2d-display 0.4.0 + GL2 的兼容性未验证；GL1 实测通过就锁定它。
// 黑剪影的根因是 model3.json 纹理声明（见 setup-overlay.mjs patchModel3），与
// GL 版本无关。v6 锁 GL1 的有效做法：先在 canvas 上取 webgl1 上下文，pixi 的
// getContext('webgl2') 会返回 null 而回退 GL1。
document.getElementById('stage').getContext('webgl')
  || document.getElementById('stage').getContext('webgl2')
const app = new PIXI.Application({ view: document.getElementById('stage'), backgroundAlpha: 0 })
let model = null, mouthTimer = null, mouthOpen = 0
let wasSpeaking = false, lastMotion = null, lastExp = null
let naturalH = 0   // 缩放前的自然高度：fit 幂等依据（model.height 会随 scale 变）

// 假口型：直接 setInterval 写参数会被 motion/expression 覆盖。
// beforeModelUpdate 在 motion、expression、physics 之后、coreModel.update 之前
// 触发，是官方扩展点；在这里写口型既不被覆盖，也不会延后一帧。
// 仅 speaking 接管 MouthOpenY；其他状态必须保留表达式自带的张嘴值，
// 否则微笑/困倦/惊讶的嘴会被「闭嘴」钩子抹掉。
function hookMouth() {
  model.internalModel.on('beforeModelUpdate', () => {
    const cm = model.internalModel.coreModel
    // 身体跟随头部：素材头/身网格在 y≈-0.5 平齐零搭接，头部摆动会拉开脖缝。
    // 让 BodyAngle 跟随 Angle（motion 自带的 BodyAngle 摆动值保留，叠加跟随量）。
    // 必须无条件执行：idle 待机时接缝同样会裂。Z 不叠加 motion 的 BodyAngleZ，
    // 避免与跟随量同向翻倍。
    try {
      cm.setParameterValueById('ParamBodyAngleX', cm.getParameterValueById('ParamBodyAngleX') + cm.getParameterValueById('ParamAngleX') * BODY_FOLLOW_K)
      cm.setParameterValueById('ParamBodyAngleY', cm.getParameterValueById('ParamBodyAngleY') + cm.getParameterValueById('ParamAngleY') * BODY_FOLLOW_K)
      cm.setParameterValueById('ParamBodyAngleZ', cm.getParameterValueById('ParamAngleZ') * BODY_FOLLOW_K)
    } catch {}
    if (!wasSpeaking) return
    try { cm.setParameterValueById('ParamMouthOpenY', mouthOpen) } catch {}
  })
}

window.__nico = {
  async init() {
    log('model.js: init begin')
    // 0.4.0：motionPreload 是 from() 的 option（config.motionPreload 在此版本不存在）。
    model = await PIXI.live2d.Live2DModel.from(MODEL_URL, { motionPreload: 'ALL' })
    log('model.js: model loaded ' + model.width + 'x' + model.height)
    naturalH = model.height   // 此刻 scale=1，记录自然尺寸供 fit 幂等使用
    model.anchor.set(0.5, 1)
    // Core 5.x 兼容：部件透明度全 1 时 hair/whale ear 等 drawable 的
    // getDrawableDynamicFlagIsVisible 仍返回 false，渲染器直接跳过 → 光头。
    // 强制全 true 安全：变体层靠 opacity=0 隐藏，可见标志不参与隐藏。
    try {
      model.internalModel.coreModel.getDrawableDynamicFlagIsVisible = function () { return true }
    } catch (e) {
      log('visibility patch failed: ' + (e?.message || e))
    }
    hookMouth()
    app.stage.addChild(model)
    fit(); addEventListener('resize', fit)
    requestAnimationFrame(fit)   // 首帧后再校一次，兜底 webview 晚摆位
    log('model.js: init done canvas=' + app.renderer.width + 'x' + app.renderer.height)
  },
  setState(s) {
    // state==="idle"（人物侧待机展示态）：不触发 motion/exp 变化——pixi-live2d-display
    // 自动播 Idle 组；口型走下方 speaking=false 分支归 0。
    // motion/expression 去重：FORCE 会从头重播导致闪烁，相同组名不重复触发。
    if (s.state !== 'idle') {
      if (model && s.motion && s.motion !== lastMotion) {
        model.motion(s.motion, undefined, PIXI.live2d.MotionPriority?.FORCE)
        lastMotion = s.motion
      }
      if (model && s.exp && s.exp !== lastExp) {
        model.expression(s.exp)
        lastExp = s.exp
      }
    }
    // speaking 时 120ms 节奏随机开合；其余状态闭嘴。
    // 仅在进出 speaking 时清理/重建 interval，避免高频 setState 反复重建定时器。
    const speaking = s.state === 'speaking'
    if (speaking !== wasSpeaking) {
      clearInterval(mouthTimer)
      if (speaking) {
        mouthTimer = setInterval(() => {
          mouthOpen = Math.random() < 0.25 ? 0 : 0.15 + Math.random() * 0.6
        }, 120)
      } else {
        mouthOpen = 0
      }
      wasSpeaking = speaking
    }
  },
}
function fit() {
  // 先把 canvas 撑到当前窗口尺寸（webview 迟摆位时靠这句补上）。
  app.renderer.resize(innerWidth, innerHeight)
  if (!model) return
  // 人物窗只装人物（无气泡区），人物几乎占满整窗高。
  // scale 按自然高度算：model.height 是缩放后边界高度，用它连算两次会失真。
  const targetH = innerHeight * 0.95
  model.scale.set(targetH / (naturalH || model.height))
  model.position.set(innerWidth * 0.5, innerHeight * 0.99)
  // 头部位置回传（画布坐标，y 向下）：宿主把「新会话」按钮钉在头的右侧。
  // 人物窄而窗口宽时，钉窗角会让按钮离头很远。
  try {
    const b = model.getBounds()
    window.webkit?.messageHandlers?.nicoHead?.postMessage({ x: b.x + b.width / 2, y: b.y })
  } catch {}
}
window.__nico.init().catch((e) => {
  document.title = 'init-failed: ' + e.message
  log('model init FAILED: ' + (e.stack || e.message))
})
