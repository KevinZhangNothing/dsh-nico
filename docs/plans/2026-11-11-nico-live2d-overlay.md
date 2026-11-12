# Nico Live2D Overlay 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**目标：** 把 dsh-nico 的右上角 sprite 气泡重构为样图形态的 Live2D overlay：人物贴底居中、气泡锚在头顶、listening/thinking/start/speaking/end/fail 六态、可拖动并记忆位置。

**架构：** 保留 NSPanel 壳与 stdin JSON 协议骨架（`lib/index.js` spawn `native/bubble`），内容换成透明 WKWebView 加载 pixi-live2d-display 渲染 Live2D 模型（DeepSeek 鲸鱼娘），气泡为 DOM 层。状态机在 `lib/overlay-proto.mjs`（纯函数、可测），部署走 `scripts/setup-overlay.mjs`（与 setup-rt 同模式）。

**技术栈：** Swift + WebKit（WKWebView）、pixi.js@6 + pixi-live2d-display@0.4 + Cubism Web Core、node:test。

**设计文档：** `docs/plans/2026-11-11-nico-live2d-overlay-design.md`

**注意（来自 AGENTS.md）：** 不主动 commit——计划中不含 git 提交步骤，改动留在工作区由用户决定提交。工作目录：`/Users/kevin/Desktop/Nothing/dsh-plugins/dsh-nico`；Live2D 素材：`/Users/kevin/Desktop/Nothing/live2d-deepseek-whale-girl/cubism/`。

---

### 任务 1：状态映射模块 `lib/overlay-proto.mjs`

**文件：**
- 创建：`lib/overlay-proto.mjs`
- 测试：`test/overlay-proto.test.mjs`

**步骤 1：编写失败的测试**

```js
// test/overlay-proto.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventToState, decorate, legacyShow } from '../lib/overlay-proto.mjs'

test('rec-start → listening 带默认 hint', () => {
  const s = decorate(eventToState('rec-start'))
  assert.equal(s.state, 'listening')
  assert.match(s.hint, /Release to send/)
  assert.equal(s.motion, 'Idle')
  assert.equal(s.exp, 'f01_normal')
})

test('transcript(有文本) → thinking 带 sleepy 表情', () => {
  const s = decorate(eventToState('transcript', { text: '整理桌面' }))
  assert.equal(s.state, 'thinking')
  assert.equal(s.text, '整理桌面')
  assert.equal(s.exp, 'f08_sleepy')
})

test('transcript(空文本) → null（调用方收气泡）', () => {
  assert.equal(eventToState('transcript', { text: '' }), null)
})

test('reply ok → start(Nod+surprised)；fail → Shake+angry', () => {
  assert.equal(decorate(eventToState('reply-ok', { reply: '好' })).motion, 'Nod')
  const f = decorate(eventToState('fail', { text: ' boom' }))
  assert.equal(f.motion, 'Shake')
  assert.equal(f.exp, 'f03_angry')
})

test('speak → speaking(f02_smile, 无 motion)；tts-done → end(Bow)', () => {
  const sp = decorate(eventToState('speak', { reply: 'x' }))
  assert.equal(sp.state, 'speaking'); assert.equal(sp.exp, 'f02_smile')
  const en = decorate(eventToState('tts-done', { reply: 'x' }))
  assert.equal(en.motion, 'Bow')
})

test('legacyShow 兼容旧 emoji 前缀', () => {
  assert.equal(legacyShow('🎙 录音中…').state, 'listening')
  assert.equal(legacyShow('✅ done').state, 'end')
  assert.equal(legacyShow('⚠️ bad').state, 'fail')
  assert.equal(legacyShow('📝 text').state, 'thinking')
  assert.equal(legacyShow('其他').state, 'listening')
})
```

**步骤 2：运行测试验证失败**

```bash
node --test test/overlay-proto.test.mjs
```
预期：FAIL（模块不存在）。

**步骤 3：实现**

```js
// lib/overlay-proto.mjs
// Overlay 状态机：voice 事件 → stdin 协议载荷（给 native/bubble 的 WKWebView）。
// 六态：listening / thinking / start / speaking / end / fail。

const MOTION = {
  listening: { motion: 'Idle',  exp: 'f01_normal' },
  thinking:  { motion: null,    exp: 'f08_sleepy' },
  start:     { motion: 'Nod',   exp: 'f05_surprised' },
  speaking:  { motion: null,    exp: 'f02_smile' },
  end:       { motion: 'Bow',   exp: 'f02_smile' },
  fail:      { motion: 'Shake', exp: 'f03_angry' },
}

export function eventToState(event, p = {}) {
  switch (event) {
    case 'rec-start':  return { state: 'listening', hint: 'Release to send · Press Esc to cancel' }
    case 'transcript': return p.text ? { state: 'thinking', text: p.text } : null
    case 'reply-ok':   return { state: 'start', text: p.reply, hint: 'Starting the task…' }
    case 'speak':      return { state: 'speaking', text: p.reply }
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
  if (text.startsWith('🎙')) return { state: 'listening' }
  if (text.startsWith('📝')) return { state: 'thinking', text: text.slice(2) }
  if (text.startsWith('✅')) return { state: 'end', text: text.slice(2) }
  if (text.startsWith('⚠️')) return { state: 'fail', text: text.slice(2) }
  return { state: 'listening', text }
}
```

**步骤 4：运行测试验证通过**

```bash
node --test test/overlay-proto.test.mjs   # 预期：全部 PASS
```

---

### 任务 2：部署脚本 `scripts/setup-overlay.mjs`

**文件：**
- 创建：`scripts/setup-overlay.mjs`
- 测试：`test/setup-overlay.test.mjs`
- 参考：`scripts/setup-rt.mjs`（既有抽取模式）、`lib/paths.mjs`（`NICO_DIR`）

**步骤 1：编写失败的测试**

```js
// test/setup-overlay.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patchModel3 } from '../scripts/setup-overlay.mjs'

test('patchModel3 按文件序修正 expression Name（构建脚本把 8 个都写成了"普通"）', () => {
  const model3 = { FileReferences: { Expressions: [
    { Name: '普通', File: 'exp/f01_normal.exp3.json' },
    { Name: '普通', File: 'exp/f02_smile.exp3.json' },
    { Name: '普通', File: 'exp/f08_sleepy.exp3.json' },
  ] } }
  const out = patchModel3(model3)
  assert.equal(out.FileReferences.Expressions[0].Name, 'f01_normal')
  assert.equal(out.FileReferences.Expressions[1].Name, 'f02_smile')
  assert.equal(out.FileReferences.Expressions[2].Name, 'f08_sleepy')
})
```

**步骤 2：运行测试验证失败**

```bash
node --test test/setup-overlay.test.mjs   # 预期：FAIL
```

**步骤 3：实现**

```js
// scripts/setup-overlay.mjs
// 部署 Live2D overlay 运行时到 ~/.dsh/nico/rt/：
//   rt/live2d/   ← 素材（默认取 ../live2d-deepseek-whale-girl/cubism，可用 NICO_LIVE2D_SRC 覆盖）
//   rt/overlay/  ← overlay.html/overlay.js（从插件 native/overlay/ 拷贝）
//                  + pixi.min.js / pixi-live2d-display.min.js / live2dcubismcore.min.js（CDN 拉取）
// Cubism Core 不随插件分发（Live2D 许可），与 sherpa-onnx 同为 setup 期拉取。
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NICO_DIR } from '../lib/paths.mjs'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
export const EXP_NAMES = ['f01_normal','f02_smile','f03_angry','f04_sad',
                          'f05_surprised','f06_blush','f07_wink','f08_sleepy']

export function patchModel3(json) {
  const m = typeof json === 'string' ? JSON.parse(json) : { ...json }
  m.FileReferences.Expressions.forEach((e, i) => { e.Name = EXP_NAMES[i] ?? e.File })
  return m
}

export async function download(url, dest) {
  const r = await fetch(url)
  if (!r.ok) throw new Error('download ' + url + ' → ' + r.status)
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()))
}

export async function setupOverlay({
  src = process.env.NICO_LIVE2D_SRC
        ?? join(PLUGIN_DIR, '..', 'live2d-deepseek-whale-girl', 'cubism'),
  rt = join(NICO_DIR, 'rt'),
} = {}) {
  const live2d = join(rt, 'live2d'), overlay = join(rt, 'overlay')
  if (!existsSync(join(src, 'DeepseekWhaleGirl.model3.json'))
    && !existsSync(join(src, 'model3.json')))
    throw new Error('Live2D 素材不存在：' + src + '（设 NICO_LIVE2D_SRC 指向 cubism/ 目录）')
  mkdirSync(live2d, { recursive: true }); mkdirSync(overlay, { recursive: true })

  const modelFile = existsSync(join(src, 'DeepseekWhaleGirl.model3.json'))
    ? 'DeepseekWhaleGirl.model3.json' : 'model3.json'
  for (const f of ['DeepseekWhaleGirl.moc3', 'DeepseekWhaleGirl.4096.png',
                   'physics3.json', 'userdata3.json'])
    if (existsSync(join(src, f))) cpSync(join(src, f), join(live2d, f))
  cpSync(join(src, 'motions'), join(live2d, 'motions'), { recursive: true })
  cpSync(join(src, 'exp'), join(live2d, 'exp'), { recursive: true })
  writeFileSync(join(live2d, modelFile),
    JSON.stringify(patchModel3(readFileSync(join(src, modelFile), 'utf8'))))

  cpSync(join(PLUGIN_DIR, 'native', 'overlay'), overlay, { recursive: true })
  await Promise.all([
    download('https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
             join(overlay, 'live2dcubismcore.min.js')),
    download('https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js',
             join(overlay, 'pixi.min.js')),
    download('https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/index.min.js',
             join(overlay, 'pixi-live2d-display.min.js')),
  ])
  console.error('setup-overlay: 就绪 → ' + rt)
}

if (import.meta.url === 'file://' + process.argv[1]) {
  setupOverlay().catch((e) => { console.error(e.message); process.exit(1) })
}
```

注意：若素材目录里 `model3.json` 与 `DeepseekWhaleGirl.model3.json` 命名不同，以实际为准（当前素材库两者都有，`cubism/model3.json` 引用同目录文件名）。

**步骤 4：运行测试 + 实跑**

```bash
node --test test/setup-overlay.test.mjs   # PASS
node scripts/setup-overlay.mjs            # 预期：stderr "setup-overlay: 就绪"，ls ~/.dsh/nico/rt/{live2d,overlay} 非空
```

---

### 任务 3：渲染层 `native/overlay/overlay.html` + `overlay.js`

**文件：**
- 创建：`native/overlay/overlay.html`
- 创建：`native/overlay/overlay.js`

**说明：** 无自动化测试（纯 UI）；验证方式是浏览器直接打开（Core/模型全部本地 file:// 加载），这也是后续调样式的快速迭代入口。

**步骤 1：写 overlay.html**

```html
<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: transparent; overflow: hidden;
               font-family: -apple-system, "PingFang SC", sans-serif; user-select: none }
  #bubble { position: absolute; top: 10px; left: 58%; transform: translateX(-50%);
            min-width: 340px; max-width: 540px; background: rgba(255,255,255,.97);
            border-radius: 22px; padding: 14px 20px;
            box-shadow: 0 10px 36px rgba(50,20,90,.28); transition: opacity .3s }
  #bubble:after { content: ''; position: absolute; bottom: -10px; left: 50%;
                  margin-left: -10px; border: 10px solid transparent;
                  border-top-color: rgba(255,255,255,.97); border-bottom: 0 }
  #head { display: flex; gap: 8px; align-items: center; color: #8a8fa3;
          font-size: 12px; font-weight: 600 }
  #hico { color: #e0556a }           /* listening 红点动画由 JS 控制 */
  #text { margin-top: 6px; font-size: 17px; line-height: 1.35; color: #1c2237 }
  #hint { margin-top: 4px; font-size: 12px; color: #9aa0b4 }
  canvas { position: absolute; bottom: 0; left: 0 }
</style>
<div id="bubble" style="opacity:0">
  <div id="head"><span id="hico"></span><span id="hlabel"></span></div>
  <div id="text"></div><div id="hint"></div>
</div>
<canvas id="stage"></canvas>
<script src="live2dcubismcore.min.js"></script>
<script src="pixi.min.js"></script>
<script src="pixi-live2d-display.min.js"></script>
<script src="overlay.js"></script>
```

**步骤 2：写 overlay.js**

```js
// 渲染层：pixi + Live2D 人物 + DOM 气泡。宿主（bubble.swift）只调 window.__nico.setState。
const HEAD = {
  listening: ['●',  'Listening'],           thinking: ['◌', 'Thinking'],
  start:     ['⏵', 'Starting the task…'],   speaking: ['〰', 'Speaking'],
  end:       ['✓', 'Done'],                 fail:     ['!', 'Failed'],
}
const $ = (id) => document.getElementById(id)
const app = new PIXI.Application({ view: $('stage'), resizeTo: window, backgroundAlpha: 0 })
let model = null, mouthTimer = null

window.__nico = {
  async init() {
    PIXI.live2d.config.motionPreload = 'idle'
    model = await PIXI.live2d.Live2DModel.from('live2d/DeepseekWhaleGirl.model3.json')
    model.anchor.set(0.5, 0)
    fit(); addEventListener('resize', fit)
    app.stage.addChild(model)
  },
  setState(s) {
    const [ico, label] = HEAD[s.state] ?? HEAD.listening
    $('bubble').style.opacity = 1
    $('hico').textContent = ico; $('hlabel').textContent = label
    $('hico').style.color = s.state === 'listening' ? '#e0556a' : '#a06bd4'
    $('text').textContent = s.text ?? ''; $('hint').textContent = s.hint ?? ''
    if (s.motion) model.motion(s.motion)
    if (s.exp) model.expression(s.exp)
    // 假口型：speaking 时 120ms 节奏开合 ParamMouthOpenY；其余状态闭嘴。
    clearInterval(mouthTimer)
    if (s.state === 'speaking') {
      mouthTimer = setInterval(() => {
        const v = Math.random() < 0.25 ? 0 : 0.15 + Math.random() * 0.6
        model.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', v)
      }, 120)
    }
  },
}
function fit() {
  if (!model) return
  const targetH = innerHeight * 0.80
  model.scale.set(targetH / model.height)
  model.position.set(innerWidth * 0.55, innerHeight * 0.985)
}
window.__nico.init().catch((e) => document.title = 'init-failed: ' + e.message)
```

**步骤 3：手动验证**

```bash
node scripts/setup-overlay.mjs
open ~/.dsh/nico/rt/overlay/overlay.html
```
预期（Safari/Chrome）：人物显示在窗口底部；DevTools 控制台执行
`__nico.setState({state:'listening',motion:'Idle',exp:'f01_normal',text:'测试',hint:'x'})`
→ 气泡出现 Listening + 文本；执行 `{state:'start',motion:'Nod',exp:'f05_surprised'}` → 人物点头。
标题不能出现 `init-failed`。

---

### 任务 4：改造 `native/bubble.swift`（NSPanel 壳 → WKWebView）

**文件：**
- 重写：`native/bubble.swift`（编译入口不变：`lib/index.js` 用 swiftc 编译它到 `~/.dsh/nico/rt/bubble`）

**步骤 1：实现**（关键点全量给出，直接替换整个文件）

```swift
// nico overlay — 透明 NSPanel + WKWebView 渲染 Live2D 人物与状态气泡。
// stdin 一行一 JSON：
//   {"op":"state","state":"listening","text":"…","hint":"…","motion":"Idle","exp":"f01_normal"}
//   {"op":"close"}    隐藏并退出
// 窗口 = 人物+气泡联合包围盒，贴底居中；可拖动，位置记忆，show 不重置位置。
import Cocoa
import WebKit

final class DragWKWebView: WKWebView {
  override var mouseDownCanMoveWindow: Bool { true }
  override func mouseDown(with e: NSEvent) { window?.performDrag(with: e) }
  override func otherMouseDown(with e: NSEvent) { window?.performDrag(with: e) }
}

final class Overlay: NSObject, WKNavigationDelegate {
  static let bubbleH: CGFloat = 170
  let panel: NSPanel
  let web: DragWKWebView
  let rt: String
  let posFile: String
  var visible = false

  override init() {
    rt = ProcessInfo.processInfo.environment["NICO_RT"]
      ?? NSString(string: "~/.dsh/nico/rt").expandingTildeInPath
    posFile = ProcessInfo.processInfo.environment["NICO_POS_FILE"]
      ?? NSString(string: "~/.dsh/nico/bubble_pos.json").expandingTildeInPath
    panel = NSPanel(contentRect: .zero,
                    styleMask: [.borderless, .nonactivatingPanel],
                    backing: .buffered, defer: false)
    web = DragWKWebView(frame: .zero)
    super.init()
    panel.level = .statusBar
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false                       // 气泡 DOM 自带阴影
    panel.isMovableByWindowBackground = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .stationary]
    panel.hidesOnDeactivate = false
    panel.title = "nico"
    web.setValue(false, forKey: "drawsBackground")   // WKWebView 透明
    web.navigationDelegate = self
    panel.contentView = web
    NotificationCenter.default.addObserver(
      forName: NSWindow.didMoveNotification, object: panel, queue: .main
    ) { [weak self] _ in self?.savePos() }
    web.loadFileURL(URL(fileURLWithPath: rt + "/overlay/overlay.html"),
                    allowingReadAccessTo: URL(fileURLWithPath: rt))
  }

  func defaultFrame() -> NSRect {
    let vf = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let w: CGFloat = 680
    let h = min(vf.height * 0.40, 430) + Overlay.bubbleH
    return NSRect(x: vf.midX - w / 2, y: vf.origin.y, width: w, height: h)
  }

  func savePos() {
    guard let f = panel.windowNumber != 0 ? panel.frame : nil else { return }
    try? JSONSerialization.data(withJSONObject: ["x": f.origin.x, "y": f.origin.y])
      .write(to: URL(fileURLWithPath: posFile))
  }
  func restorePos() -> NSPoint? {
    guard let d = try? Data(contentsOf: URL(fileURLWithPath: posFile)),
          let o = try? JSONSerialization.jsonObject(with: d) as? [String: CGFloat],
          let x = o["x"], let y = o["y"] else { return nil }
    return NSPoint(x: x, y: y)
  }

  func show() {
    DispatchQueue.main.async {
      if !self.visible {
        var f = self.defaultFrame()
        if let p = self.restorePos() { f.origin = p }
        self.panel.setFrame(f, display: false)
        self.panel.alphaValue = 0
        self.panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { c in
          c.duration = 0.25
          self.panel.animator().alphaValue = 1
        }
        self.visible = true
      }
    }
  }
  func apply(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
          let json = String(data: data, encoding: .utf8) else { return }
    show()
    DispatchQueue.main.async {
      self.web.evaluateJavaScript("window.__nico.setState(\(json))", completionHandler: nil)
      if obj["state"] as? String == "end" || obj["state"] as? String == "fail" {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
          guard let self = self, self.visible else { return }
          NSAnimationContext.runAnimationGroup { c in
            c.duration = 0.4
            self.panel.animator().alphaValue = 0
          } completionHandler: {
            self.panel.orderOut(nil); self.visible = false
          }
        }
      }
    }
  }
  func close() { DispatchQueue.main.async { exit(0) } }
}

// stdin → 主队列（沿用旧实现的线程模式）。
func startStdin(_ apply: @escaping ([String: Any]) -> Void, _ close: @escaping () -> Void) {
  Thread.detachNewThread {
    var line = ""
    while let s = String(data: FileHandle.standardInput.availableData, encoding: .utf8), !s.isEmpty {
      line += s
      while let nl = line.firstIndex(of: "\n") {
        let cmd = String(line[line.startIndex..<nl]).trimmingCharacters(in: .whitespaces)
        line = String(line[line.index(after: nl)...])
        guard !cmd.isEmpty, let o = try? JSONSerialization.jsonObject(with: Data(cmd.utf8)) as? [String: Any] else { continue }
        if o["op"] as? String == "close" { close(); return }
        if o["op"] == "state" || o["op"] == "show" { apply(o) }
      }
    }
    close()
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let overlay = Overlay()
startStdin({ o in
  var s = o
  if o["op"] == "show" {   // 旧协议兼容
    s["state"] = "listening"; s["text"] = o["text"]; s["exp"] = o["expr"]
  }
  overlay.apply(s)
}, { overlay.close() })
app.run()
```

注意：`guard let f = panel.windowNumber != 0 ? panel.frame : nil` 处 `panel.frame` 恒非 nil，写成 `guard panel.windowNumber != 0 else { return }` + 直接取 frame 更清晰——落地时用后者。

**步骤 2：编译验证**

```bash
mkdir -p ~/.dsh/nico/rt && swiftc -O -o ~/.dsh/nico/rt/bubble native/bubble.swift -framework WebKit -framework Cocoa
```
预期：编译通过，无警告级错误。

**步骤 3：stdin 手动驱动验证**

```bash
printf '{"op":"state","state":"listening","motion":"Idle","exp":"f01_normal","text":"hello"}\n' | ~/.dsh/nico/rt/bubble
```
预期：人物贴底居中淡入、气泡显示 hello；拖动窗口；再次运行同命令验证位置保留（不弹回中央）；
发 `{"op":"state","state":"end"}` → 1.6s 后淡出消失；发 `{"op":"close"}` → 进程退出。

---

### 任务 5：`lib/voice.mjs` 增加 tts-start / tts-done 事件

**文件：**
- 修改：`lib/voice.mjs:64-65`（`reply` emit 之后）

**步骤 1：修改**

```js
      this.emit('reply', { ok, reply, ok, reason, text })   // 保留原行，勿双写 ok
      this.emit('tts-start', { reply })
      await this.say(reply)          // say 可能是同步实现，await 兼容两种
      this.emit('tts-done', { reply })
```
（实际 diff：在 `this.emit('reply', …)` 与 `this.say(reply)` 之间插入 tts-start，`this.say(reply)` 改为 `await` 并在其后 emit tts-done。）

**步骤 2：验证**

无单测（`transcribe`/`runCommand` 为模块级 import，注入成本高于收益）；验证并入任务 6 的端到端。

---

### 任务 6：`lib/index.js` 接线

**文件：**
- 修改：`lib/index.js:100-124`（bubbleSend/bubbleShow）、`lib/index.js:302-311`（voice 事件接）、`lib/index.js:60-78`（编译入口不变）
- 说明：删掉 bubbleShow 的 emoji/expr 语义，统一 `eventToState + decorate`；spawn env 增加 `NICO_RT`。

**步骤 1：替换发送层**

```js
import { eventToState, decorate, legacyShow } from './overlay-proto.mjs'

let lastReply = ''
function pushState(event, payload) {
  const s = decorate(eventToState(event, payload))
  if (s) bubbleSend({ op: 'state', ...s })
}
```
（`bubbleSend`/`spawn` 骨架保留，env 里补 `NICO_RT: paths.rtDir()`——若 `lib/paths.mjs` 无该导出，加一个 `export const RT_DIR = join(NICO_DIR, 'rt')`。）

**步骤 2：替换 voice 事件块（原 302-311 行）**

```js
voice.on('rec-start', () => { log('录音…'); pushState('rec-start') })
voice.on('transcript', (t) => { log('识别：' + t); if (t) pushState('transcript', { text: t }) })
voice.on('reply', ({ ok, reply }) => {
  lastReply = reply
  if (ok) pushState('reply-ok', { reply })
  else { pushState('fail', { text: reply }); setTimeout(bubbleClose, 2000) }
})
voice.on('tts-start', () => pushState('speak', { reply: lastReply }))
voice.on('tts-done', () => pushState('tts-done', { reply: lastReply }))
voice.on('rec-fail', () => { pushState('fail', { text: '录音失败' }); setTimeout(bubbleClose, 2000) })
```

**步骤 3：编译冒烟**

```bash
node --test test/          # 全部既有测试 + 任务1/2 的新测试 PASS
node -e "import('./lib/index.js').then(m => console.log(typeof m.apply))"   # 打印 function
```

---

### 任务 7：端到端验证 + README

**步骤 1：端到端清单（手动，daemon 路径）**

```bash
dsh plugin --profile headless add .   # 或现有安装方式更新后
node scripts/setup-overlay.mjs
```
按住右⌘走一轮：
1. 按下 → 人物贴底居中淡入，气泡 Listening + 红点，idle 待机。
2. 说话松开 → 气泡转 Thinking + 已识别文本，人物困倦。
3. 回复到达 → 人物点头，气泡 Starting the task…。
4. TTS 播放 → 气泡 Speaking + 回复全文，口型开合。
5. 播完 → Bow，气泡淡出，窗口隐藏。
6. 拖动人物到屏幕左下角，重复一轮 → 位置不重置。
7. 断网重跑 `nico daemon` → Core/pixi 已缓存，无网络请求（`rt/` 本地加载）。

**步骤 2：README 更新**

- 「能力」加一条：Live2D overlay（DeepSeek 鲸鱼娘）六态气泡 + 可拖动记忆位置。
- 「准备运行时」加：`nico setup` 之后执行 `node scripts/setup-overlay.mjs`（素材目录用 `NICO_LIVE2D_SRC` 指定）；注明 Cubism Core 来自 Live2D 官方 CDN、不随插件分发。
- 「已知限制」加：WKWebView 透明层在 macOS 27 需实测；说话口型为节奏假口型，RMS 驱动留待 CosyVoice 流式路径。

---

## 验证总口径

- `node --test test/` 全绿。
- 任务 3 浏览器预览、任务 4 stdin 驱动、任务 7 端到端三项手动验证全部通过，才算完成。
- 风险回落路径：任务 4 若 webview 透明/渲染在 macOS 27 异常，git 工作区保留旧版 `bubble.swift`（sprite 版），恢复编译入口即可回退。
