// nico overlay — 双窗结构：人物窗（charPanel）+ 毛玻璃气泡窗（bubblePanel）。
//
// 两个无边框、不抢焦点的 NSPanel，各由一个 WKWebView 渲染：
//   charPanel   → nico:///overlay/model.html  （pixi + Live2D 人物 + 口型）
//   bubblePanel → nico:///overlay/bubble.html （状态文字；浅色毛玻璃背景由原生
//                  NSVisualEffectView（.hudWindow 深色材质，.behindWindow 混合）
//                  提供，CAShapeLayer 裁出圆角——CSS backdrop-filter 糊不到
//                  桌面，毛玻璃必须原生画）
// 页面与其 XHR 全部走 nico:// 自定义协议（RtSchemeHandler 供文件）：file://
// 下 XHR 被同源策略拦死，Live2D 模型加载不了。
// 宿主进程经 stdin 逐行 JSON 驱动（一行一 op）：
//   {"op":"state","state":"listening","text":"…","hint":"…","motion":"Idle","exp":"f01_normal"}
//   {"op":"close"}    退出
// 旧驱动的 {"op":"show","text":…,"expr":…} 兼容映射为 state=listening（exp←expr）。
// stdin EOF 同样退出：宿主 end() 管道后进程随之回收。
// 人物常驻：end/fail 只淡出收起 bubblePanel，charPanel 不淡出；state=="idle" 时
// bubblePanel 整窗不上屏（在屏则淡出 orderOut），人物在屏待机。close 仍整体退出。
//
// 几何：charPanel 宽 680、高 min(vf.height*0.40,430)，贴底居中；bubblePanel
// 水平中心 = charPanel 中心 + 4% 屏宽、底边 = charPanel 顶边 - 12（还原样图
// 构图），宽高由 bubble.js 按文字内容量出后经 script message 回传自适应
// （BUBBLE_MIN_W/BUBBLE_MIN_H 兜底短文案）。两窗按此关系跟随：拖动任意一窗，
// 另一窗在 didMove 里摆回关系位（didMove 通知异步送达，瞬时标志挡不住回声，
// 防递归靠几何等价：对方已在关系位 ±0.5px 内就跳过、不写盘）。位置记忆只存 charPanel origin（bubble 由关系推导），在
// ~/.dsh/nico/bubble_pos.json —— 仅用户拖动（didMove 且位置确实变了）才写，
// show 摆位序列不写文件。
//
// 隐式契约：model.js / bubble.js 各自暴露 window.__nico.setState(s)；
// model 页吃 motion/exp/state（speaking 口型），bubble 页吃 state/text/hint，
// 量完内容尺寸再 postMessage('nicoSize') 回传。页面自调 __nico.init()，失败时
// 把 document.title 写成 'init-failed: …'（Swift 侧不依赖它，但调试时看标题
// 可知渲染层 init 结果；init 失败 setState 仍可用——气泡文字在，只是人物缺失）。

import Cocoa
import WebKit
import QuartzCore

let CHAR_W: CGFloat = 680
let CHAR_H_MAX: CGFloat = 430
// 气泡尺寸：内容自适应（上限在 bubble.js 侧限制），这里只兜底防 0×0——
// 实际尺寸以 bubble.js 上报为准，极短文案就贴内容自然大小。
let BUBBLE_MIN_W: CGFloat = 40
let BUBBLE_MIN_H: CGFloat = 40
let BUBBLE_DX: CGFloat = 0.04       // 气泡中心相对人物中心的右偏（占屏宽比例，还原样图构图）

// 气泡外观可调项（边距/圆角/背景）：默认值在此，运行时用同名环境变量覆盖
// （宿主 spawn 时注入即可，无需重编译）。padX/padY 同步注入 bubble 页 CSS
// 变量，文字边距与原生圆角裁剪同源。
//   NICO_BUBBLE_RADIUS  圆角半径（pt，默认 22）
//   NICO_BUBBLE_PAD_X   文字内边距·左右（pt，默认 14）
//   NICO_BUBBLE_PAD_Y   文字内边距·上下（pt，默认 10）
//   NICO_BUBBLE_ALPHA   毛玻璃浓度 0~1（默认 0.7）
//   NICO_BUBBLE_GAP     气泡底边与人物窗顶边的间距（pt，默认 12）

// 整窗拖动：WKWebView 默认不吃窗口背景拖拽，转发给 performDrag。
final class DragWKWebView: WKWebView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with e: NSEvent) { window?.performDrag(with: e) }
    override func otherMouseDown(with e: NSEvent) { window?.performDrag(with: e) }
}

// nico:// 自定义协议：把 rt/ 下的文件喂给 WKWebView。页面必须走它——file://
// 页面的 XHR 被 WebKit 同源策略拦死（allowingReadAccessTo 只放行 script/img
// 子资源，model3.json/moc3/motions 全是 XHR 拉的，Live2D 模型因此永远加载
// 失败）。nico:///overlay/model.html → <rt>/overlay/model.html。
final class RtSchemeHandler: NSObject, WKURLSchemeHandler {
    let root: String
    init(root: String) { self.root = (root as NSString).standardizingPath }

    // 404 响应：自定义 scheme 走 WebContent 子进程的 fetch/XHR 时状态码由
    // 响应头给（200/404 都是可见的），缺文件必须回真 404 而不是 didFail——
    // 后者在部分调用方看来就是无状态的网络错误，难排查。
    private func notFound(_ task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let resp = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                                   headerFields: ["Content-Type": "text/plain"])!
        task.didReceive(resp)
        task.didReceive(Data("not found".utf8))
        task.didFinish()
    }

    func webView(_ wv: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var rel = url.path                                    // 形如 /overlay/model.html
        if rel.hasPrefix("/") { rel = String(rel.dropFirst()) }
        let full = NSString(string: (root as NSString).appendingPathComponent(rel)).standardizingPath
        // 防路径穿越：规范化后必须仍严格在 root 内（hasPrefix(root + "/")，
        // 否则 root=/rt 会被兄弟目录 /rt-evil 误放行）。
        guard full == root || full.hasPrefix(root + "/"),
              let data = try? Data(contentsOf: URL(fileURLWithPath: full)) else {
            return notFound(task)
        }
        let mime: String
        switch (full as NSString).pathExtension.lowercased() {
        case "html": mime = "text/html"
        case "js":   mime = "text/javascript"
        case "json": mime = "application/json"
        case "png":  mime = "image/png"
        default:     mime = "application/octet-stream"        // moc3 等
        }
        let resp = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": mime,
                           "Content-Length": String(data.count),
                           "Access-Control-Allow-Origin": "*"])!
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ wv: WKWebView, stop task: WKURLSchemeTask) {}
}

@MainActor final class Overlay: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    let charPanel: NSPanel
    let bubblePanel: NSPanel
    // 人物窗容器：modelWeb + 原生「新会话」按钮（WKWebView 的 mouseDown 被拖拽劫持，DOM 按钮收不到点击，按钮必须是原生 NSView）。
    let charBox: NSView
    let newSessionButton: NSButton
    let modelWeb: DragWKWebView
    let bubbleWeb: DragWKWebView
    let frost: NSVisualEffectView
    let bubbleBox: NSView              // bubblePanel contentView：毛玻璃 + 文字 webview
    let rt: String
    let posFile: String
    // 外观可调项（见文件顶部常量区注释；环境变量可覆盖）
    let bubbleRadius: CGFloat
    let bubblePadX: CGFloat
    let bubblePadY: CGFloat
    let frostAlpha: CGFloat
    let bubbleGap: CGFloat
    var visible = false
    var modelReady = false             // 各页 didFinish 前不显示 web，避免 borderless 面板白屏闪烁
    var bubbleReady = false
    var pendingModel: [String] = []    // 页面就绪前到达的 state 缓存到 didFinish 再注入
    var pendingBubble: [String] = []
    // 双窗关系锚（与气泡宽高无关，气泡自适应缩放后仍成立）：
    //   x = bubbleCenterX - charCenterX；y = bubbleMinY - charOrigin.y
    var bubbleAnchor = NSPoint(x: 0, y: 0)
    var lastOrigin: NSPoint?           // 上次已摆位/已落盘的位置；didMove 相同则非用户拖动
    var fadeGen = 0                    // 每次 apply 递增；淡出完成回调据此判断期间是否来过新 state
    var fadeWork: DispatchWorkItem?

    override init() {
        let rtRoot = ProcessInfo.processInfo.environment["NICO_RT"]
            ?? NSString(string: "~/.dsh/nico/rt").expandingTildeInPath
        rt = rtRoot
        posFile = ProcessInfo.processInfo.environment["NICO_POS_FILE"]
            ?? NSString(string: "~/.dsh/nico/bubble_pos.json").expandingTildeInPath
        bubbleRadius = Self.cfg("NICO_BUBBLE_RADIUS", 22)
        bubblePadX = Self.cfg("NICO_BUBBLE_PAD_X", 14)
        bubblePadY = Self.cfg("NICO_BUBBLE_PAD_Y", 10)
        frostAlpha = Self.cfg("NICO_BUBBLE_ALPHA", 0.7)
        bubbleGap = Self.cfg("NICO_BUBBLE_GAP", 12)
        charPanel = Self.makePanel("nico")
        bubblePanel = Self.makePanel("nico-bubble")
        modelWeb = Self.makeWeb(rt: rtRoot)
        bubbleWeb = Self.makeWeb(rt: rtRoot)
        charBox = NSView(frame: .zero)
        newSessionButton = NSButton(frame: .zero)
        frost = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: BUBBLE_MIN_W, height: BUBBLE_MIN_H))
        bubbleBox = NSView(frame: frost.frame)
        super.init()

        for w in [charPanel, bubblePanel] {
            w.level = .statusBar
            w.isOpaque = false
            w.backgroundColor = .clear
            w.hasShadow = false                      // 气泡视觉由毛玻璃层承担
            w.isMovableByWindowBackground = true
            w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .stationary]
            w.hidesOnDeactivate = false
        }

        // 未公开 KVC：把 WKWebView 背景变透明（页面自绘，面板不再兜底白底）。
        for w in [modelWeb, bubbleWeb] {
            w.setValue(false, forKey: "drawsBackground")
            w.navigationDelegate = self
            w.isHidden = true                        // didFinish 后才显示，避免首帧白闪
        }
        // 人物窗：容器（webview 铺满 + 原生按钮钉右上角）。webview 的 mouseDown
        // 被拖拽劫持，DOM 按钮收不到点击，所以按钮是原生 NSButton；点击经 stdout
        // 一行 JSON {"event":"new-session"} 回传宿主插件（见 newSessionClicked）。
        charPanel.contentView = charBox
        charBox.addSubview(modelWeb)
        newSessionButton.isBordered = false
        newSessionButton.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        newSessionButton.attributedTitle = NSAttributedString(
            string: "新会话",
            attributes: [.foregroundColor: NSColor.white,
                         .font: NSFont.systemFont(ofSize: 12, weight: .medium)])
        newSessionButton.target = self
        newSessionButton.action = #selector(newSessionClicked)
        newSessionButton.toolTip = "结束当前会话，开启新会话"
        newSessionButton.wantsLayer = true
        newSessionButton.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.18).cgColor
        newSessionButton.layer?.cornerRadius = 12
        newSessionButton.layer?.masksToBounds = true
        newSessionButton.autoresizingMask = [.minXMargin, .minYMargin]  // 钉右上角
        modelWeb.autoresizingMask = [.width, .height]
        charBox.addSubview(newSessionButton)
        modelWeb.load(URL(string: "nico:///overlay/model.html")!)

        // 气泡窗：容器 = 毛玻璃（受 mask 裁剪）+ 其上透明文字 webview。
        frost.material = .hudWindow   // 深色毛玻璃（文字统一亮白，用户决策）
        frost.blendingMode = .behindWindow           // 糊到桌面/下层窗口
        frost.state = .active
        frost.wantsLayer = true
        frost.alphaValue = frostAlpha
        frost.layer?.mask = Self.frostMask(bounds: frost.bounds, radius: bubbleRadius)
        bubbleBox.addSubview(frost)
        bubbleBox.addSubview(bubbleWeb)
        bubblePanel.contentView = bubbleBox
        for w in [modelWeb, bubbleWeb] {
            w.configuration.userContentController.add(self, name: "nicoLog")
        }
        bubbleWeb.configuration.userContentController.add(self, name: "nicoSize")
        bubbleWeb.load(URL(string: "nico:///overlay/bubble.html")!)

        let nc = NotificationCenter.default
        // queue: .main 保证回调在主线程；block 本身非隔离，assumeIsolated 进 MainActor。
        nc.addObserver(forName: NSWindow.didMoveNotification, object: charPanel, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.charDidMove() } }
        nc.addObserver(forName: NSWindow.didMoveNotification, object: bubblePanel, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.bubbleDidMove() } }
    }

    // 每个 webview 独立 configuration，都挂 nico:// 协议 handler（见类注释）。
    private static func makeWeb(rt: String) -> DragWKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(RtSchemeHandler(root: rt), forURLScheme: "nico")
        return DragWKWebView(frame: .zero, configuration: cfg)
    }

    private static func makePanel(_ title: String) -> NSPanel {
        let p = NSPanel(contentRect: .zero,
                        styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.title = title
        return p
    }

    // 圆角矩形 mask。尾巴已按需求去掉；半径夹到不超过短边一半。
    private static func frostMask(bounds: NSRect, radius: CGFloat) -> CAShapeLayer {
        let layer = CAShapeLayer()
        layer.frame = bounds
        let r = min(radius, min(bounds.width, bounds.height) / 2)
        let p = CGMutablePath()
        p.addRoundedRect(in: bounds, cornerWidth: r, cornerHeight: r)
        layer.path = p
        return layer
    }

    // 外观可调项读取：环境变量 > 默认值。
    private static func cfg(_ env: String, _ def: CGFloat) -> CGFloat {
        if let s = ProcessInfo.processInfo.environment[env], let v = Double(s) { return CGFloat(v) }
        return def
    }

    // MARK: 新会话按钮

    // container bounds 变化（show 摆位）后校一次；日常变化由 autoresizing 承担。
    func layoutButton() {
        let b = charBox.bounds
        modelWeb.frame = charBox.bounds
        newSessionButton.frame = NSRect(x: b.width - 78, y: b.height - 32, width: 70, height: 24)
    }

    @objc func newSessionClicked() {
        // stdout 是宿主回传事件的唯一通道（stdio 'pipe'），一行一个 JSON。
        FileHandle.standardOutput.write(Data("{\"event\":\"new-session\"}\n".utf8))
    }

    // MARK: 几何

    // M1: 取 charPanel 所在屏（frame 与哪块屏相交）而非 NSScreen.main 焦点屏——
    // 拖到副屏后几何（贴底、4% 偏移）按副屏算。无相交（未上屏/窗口在屏外）时
    // 回退焦点屏，再退兜底值。
    private func visibleFrame() -> NSRect {
        let cf = charPanel.frame
        let screen = NSScreen.screens.first { cf.intersects($0.frame) }
            ?? (NSScreen.main ?? NSScreen.screens.first)
        return screen?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    }
    private func charH(_ vf: NSRect) -> CGFloat { min(vf.height * 0.40, CHAR_H_MAX) }

    // bubblePos = f(charPos)：底边 = 人物顶边 - gap，中心 = 人物中心 + 4% 屏宽。
    private func bubbleFrame(for charOrigin: NSPoint, vf: NSRect) -> NSRect {
        let cx = charOrigin.x + CHAR_W / 2 + vf.width * BUBBLE_DX
        let size = bubblePanel.frame.size
        return NSRect(x: cx - size.width / 2, y: charOrigin.y + charH(vf) - bubbleGap, width: size.width, height: size.height)
    }

    // MARK: 位置记忆

    func savePos() {
        guard charPanel.windowNumber != 0 else { return }   // 未上屏的窗口没有可信 frame
        let o = charPanel.frame.origin
        if let l = lastOrigin, l == o { return }            // show() 摆位触发的 move，不是拖动
        lastOrigin = o
        let obj: [String: Double] = ["x": Double(o.x), "y": Double(o.y)]
        guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return }
        try? d.write(to: URL(fileURLWithPath: posFile), options: .atomic)
    }

    func restorePos() -> NSPoint? {
        guard let d = FileManager.default.contents(atPath: posFile),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let x = obj["x"] as? Double, let y = obj["y"] as? Double else { return nil }
        return NSPoint(x: x, y: y)
    }

    // I2: 把记忆位置夹回包含它的那块屏的 visibleFrame，保证 char 窗与按最小
    // 尺寸派生的 bubble 窗都可见；没有任何屏能容纳（完全落屏外）时返回 nil。
    private func clampToScreen(_ p: NSPoint) -> NSPoint? {
        for s in NSScreen.screens {
            let vf = s.visibleFrame
            let ch = min(vf.height * 0.40, CHAR_H_MAX)
            let charF = NSRect(x: p.x, y: p.y, width: CHAR_W, height: ch)
            let cx = p.x + CHAR_W / 2 + vf.width * BUBBLE_DX
            let bubF = NSRect(x: cx - BUBBLE_MIN_W / 2, y: p.y + ch - bubbleGap,
                              width: BUBBLE_MIN_W, height: BUBBLE_MIN_H)
            guard vf.intersects(charF), vf.intersects(bubF) else { continue }
            return NSPoint(x: min(max(p.x, vf.minX), max(vf.minX, vf.maxX - CHAR_W)),
                           y: min(max(p.y, vf.minY), max(vf.minY, vf.maxY - ch)))
        }
        return nil
    }

    // MARK: 双窗跟随

    // didMove 通知是异步送达的：程序摆位（show/自适应缩放/跟随）触发的对方
    // didMove 到达时任何瞬时标志都已复位。防递归靠几何等价——对方已在关系
    // 位（±0.5px）就不再摆位、不写盘，跟随摆位天然收敛。
    private func approx(_ a: NSPoint, _ b: NSPoint) -> Bool {
        abs(a.x - b.x) < 0.5 && abs(a.y - b.y) < 0.5
    }

    // 拖人物窗 → 气泡窗摆回关系位，并落盘人物 origin（lastOrigin 挡掉摆位回声）。
    func charDidMove() {
        let o = charPanel.frame.origin
        let want = NSPoint(x: o.x + CHAR_W / 2 + bubbleAnchor.x - bubblePanel.frame.width / 2,
                           y: o.y + bubbleAnchor.y)
        if !approx(bubblePanel.frame.origin, want) { bubblePanel.setFrameOrigin(want) }
        savePos()
    }

    // 拖气泡窗 → 人物窗摆回关系位（bubblePos = f(charPos) 的逆），仍落盘人物 origin。
    func bubbleDidMove() {
        let f = bubblePanel.frame
        let want = NSPoint(x: f.midX - CHAR_W / 2 - bubbleAnchor.x, y: f.minY - bubbleAnchor.y)
        if approx(charPanel.frame.origin, want) { return }   // 关系已成立：程序摆位的回声
        charPanel.setFrameOrigin(want)
        savePos()
    }

    // MARK: 气泡自适应（WKScriptMessageHandler）

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "nicoLog" {
            // 渲染层诊断通道：init 失败等写到 stderr（测试/调试时可见）。
            FileHandle.standardError.write(("nicoLog: " + String(describing: message.body) + "\n").data(using: .utf8)!)
            return
        }
        guard message.name == "nicoSize", let d = message.body as? [String: Any],
              let w = d["w"] as? Double, let h = d["h"] as? Double else { return }
        resizeBubble(to: NSSize(width: max(w, BUBBLE_MIN_W), height: max(h, BUBBLE_MIN_H)))
    }

    // 按内容尺寸缩放气泡窗：底边与水平中心保持锚定（关系锚不变，跟随仍成立）。
    func resizeBubble(to size: NSSize) {
        let f = bubblePanel.frame
        guard abs(size.width - f.width) > 0.5 || abs(size.height - f.height) > 0.5 else { return }
        bubblePanel.setFrame(NSRect(x: f.midX - size.width / 2, y: f.minY, width: size.width, height: size.height),
                             display: false)
        bubbleBox.setFrameSize(size)
        frost.frame = bubbleBox.bounds
        frost.layer?.mask = Self.frostMask(bounds: frost.bounds, radius: bubbleRadius)  // path 随尺寸重建
        bubbleWeb.frame = bubbleBox.bounds
    }

    // MARK: 显示 / 淡入淡出

    // 首次显示：人物窗贴底居中 + 记忆位置覆盖 origin，气泡窗按关系位跟随，
    // 0.25s 两窗同步淡入。已可见则不动（不重置位置、不重播淡入）。
    func show() {
        if visible { return }
        let vf = visibleFrame()
        var origin = NSPoint(x: vf.midX - CHAR_W / 2, y: vf.minY)
        // I2: 记忆位置须落在某块屏上（char 窗与派生 bubble 窗均与该屏 visibleFrame
        // 相交），否则夹回该屏；完全落屏外（如显示器布局已变）回退默认位。
        if let p = restorePos(), let c = clampToScreen(p) { origin = c }
        lastOrigin = origin
        charPanel.setFrame(NSRect(origin: origin, size: NSMakeSize(CHAR_W, charH(vf))), display: false)
        layoutButton()
        let bf = bubbleFrame(for: origin, vf: vf)
        bubbleAnchor = NSPoint(x: bf.midX - (origin.x + CHAR_W / 2), y: bf.minY - origin.y)
        // bubblePanel 只摆位不 orderFront：上屏/淡入由 apply 的非 idle 分支负责——
        // 首个 state 是 idle 时不得把空毛玻璃块摆上屏（P1）。
        bubblePanel.setFrame(bf, display: false)
        charPanel.alphaValue = 0
        bubblePanel.alphaValue = 0
        visible = true
        charPanel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.25
            self.charPanel.animator().alphaValue = 1
        }
    }

    // 人物常驻：state=end/fail 的 1.6s 延迟淡出只收 bubblePanel（orderOut），
    // charPanel 保持全显不淡出。完成回调核对 fadeGen：期间来过新 state 就不收。
    func fadeOut(gen: Int) {
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.4
            self.bubblePanel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {   // 动画完成回调必在主线程
                guard let self, gen == self.fadeGen else { return }
                self.bubblePanel.orderOut(nil)
            }
        })
    }

    // 一条 state 指令：显示 → JSON 注入两个页面 → end/fail 安排延迟淡出。
    // 全部状态只在主线程读写，stdin 线程只负责投递。
    func apply(_ obj: [String: Any]) {
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.fadeGen += 1              // 使任何在途淡出（含其完成回调）失效
                self.fadeWork?.cancel()
                self.fadeWork = nil
                self.show()                    // 已可见是 no-op；淡出中途到来则已恢复 alpha
                // I2: 在途淡出是 animator 代理的隐式动画，直接赋 alphaValue 不保证
                // 覆盖（NSWindow 系没有 removeAnimation(forKey:)，那是 NSView 的
                // 实现）——对同一 key 以 0 时长动画替换在途淡出（同 key 以新换旧），
                // 再直接赋值立即归位。
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = 0
                    self.charPanel.animator().alphaValue = 1
                }
                self.charPanel.alphaValue = 1  // 打断在途淡出动画，恢复全显
                var payload = obj
                if payload["state"] == nil { payload["state"] = "listening" }
                let st = payload["state"] as? String ?? ""
                // P1：idle 时气泡无内容，空毛玻璃块不得残留屏上——bubblePanel 不上前，
                // 在屏则淡出后 orderOut（gen 校验：期间来过新 state 就不收）。
                if st == "idle" {
                    if self.bubblePanel.isVisible {
                        let gen = self.fadeGen
                        self.fadeOut(gen: gen)
                    }
                }
                // end/fail 淡出后 bubblePanel 被 orderOut；新非 idle state 重新上前
                // 并淡入。visible 只跟踪 charPanel 常驻，不再被 end 置 false。
                else if self.bubblePanel.isVisible {
                    // I2: 同 charPanel——0 时长动画替换在途淡出，再立即归位不透明。
                    NSAnimationContext.runAnimationGroup { ctx in
                        ctx.duration = 0
                        self.bubblePanel.animator().alphaValue = 1
                    }
                    self.bubblePanel.alphaValue = 1
                } else {
                    self.bubblePanel.alphaValue = 0
                    self.bubblePanel.orderFrontRegardless()
                    NSAnimationContext.runAnimationGroup { ctx in
                        ctx.duration = 0.25
                        self.bubblePanel.animator().alphaValue = 1
                    }
                }
                // JSON 注入安全：JSONSerialization 产出的合法 JSON 字面量整体内插，
                // 字符串字段里的引号/反斜杠已转义，不拼用户原文。
                if let data = try? JSONSerialization.data(withJSONObject: payload),
                   let json = String(data: data, encoding: .utf8) {
                    let js = "window.__nico.setState(\(json))"
                    // model 页吃 motion/exp/口型，bubble 页吃 text/hint/head——各取所需。
                    if self.modelReady { self.modelWeb.evaluateJavaScript(js, completionHandler: nil) }
                    else { self.pendingModel.append(js) }
                    if self.bubbleReady { self.bubbleWeb.evaluateJavaScript(js, completionHandler: nil) }
                    else { self.pendingBubble.append(js) }
                }
                if st == "end" || st == "fail" {
                    let gen = self.fadeGen
                    let work = DispatchWorkItem { [weak self] in
                        MainActor.assumeIsolated { self?.fadeOut(gen: gen) }
                    }
                    self.fadeWork = work
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6, execute: work)
                }
            }
        }
    }

    func close() {
        DispatchQueue.main.async { exit(0) }
    }

    // MARK: WKNavigationDelegate

    func webView(_ w: WKWebView, didFinish navigation: WKNavigation!) {
        let isModel = w === modelWeb
        if isModel { modelReady = true } else { bubbleReady = true }
        w.isHidden = false
        let queue = isModel ? pendingModel : pendingBubble
        if isModel { pendingModel = [] } else { pendingBubble = [] }
        if !isModel {
            // 内边距注入页面 CSS 变量（须先于缓冲的 setState——fitSize 按实际
            // padding 量尺寸）；圆角由原生 mask 承担，页面无需再画。
            let js = "for (const [k,v] of Object.entries({'--nico-padx':'\(bubblePadX)px'," +
                     "'--nico-pady':'\(bubblePadY)px'}))" +
                     " document.documentElement.style.setProperty(k,v)"
            w.evaluateJavaScript(js, completionHandler: nil)
        }
        for j in queue { w.evaluateJavaScript(j, completionHandler: nil) }
    }

    // I3: WebContent 进程被系统回收（内存压力）或导航失败时重载页面。ready 标志
    // 复位 → 重载期间新到的 state 重新入队，didFinish 重放（复用现有机制）；
    // 重载前清掉旧 pending 队列防累积。恢复本身也触发 didFail(canceled)，忽略。
    private func recoverWebView(_ w: WKWebView) {
        let isModel = w === modelWeb
        if isModel { modelReady = false } else { bubbleReady = false }
        w.isHidden = true
        if isModel { pendingModel = [] } else { pendingBubble = [] }
        w.load(URL(string: isModel ? "nico:///overlay/model.html"
                                   : "nico:///overlay/bubble.html")!)
    }

    func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
        recoverWebView(w)
    }

    func webView(_ w: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let e = error as NSError
        if e.domain == NSURLErrorDomain, e.code == NSURLErrorCancelled { return }
        recoverWebView(w)
    }

    func webView(_ w: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let e = error as NSError
        if e.domain == NSURLErrorDomain, e.code == NSURLErrorCancelled { return }
        recoverWebView(w)
    }
}

// stdin 读取放 detached 线程（DispatchSource 的 per-file API 在 Swift 6.4 下不稳，
// 沿用旧 bubble.swift 的做法）；每行一个 JSON op，partial line 先缓冲。
// I1: 按 Data 字节缓冲 + 手动增量解码——长中文文案跨管道块时，String(data:
// encoding:) 会因块尾截断多字节序列返回 nil 被误判 EOF 静默退出。改为：积累
// Data、扫 \n 切行、整行 String(decoding:as:)（此构造不失败），残块留缓冲。
func startStdin(_ handle: @escaping @Sendable ([String: Any]) -> Void) {
    Thread.detachNewThread {
        var buf = Data()
        while true {
            let chunk = FileHandle.standardInput.availableData
            if chunk.isEmpty { break }                       // EOF
            buf.append(chunk)
            while let nl = buf.firstIndex(of: UInt8(ascii: "\n")) {
                let lineBytes = buf.subdata(in: buf.startIndex..<nl)
                buf = buf.subdata(in: buf.index(after: nl)..<buf.endIndex)
                let cmd = String(decoding: lineBytes, as: UTF8.self)
                    .trimmingCharacters(in: .whitespaces)
                guard !cmd.isEmpty else { continue }
                if let obj = try? JSONSerialization.jsonObject(with: Data(cmd.utf8)) as? [String: Any] {
                    handle(obj)
                }
            }
        }
        handle(["op": "close"])   // stdin EOF：宿主关管道即随宿主退出
    }
}

// 单实例锁：对 ~/.dsh/nico/bubble.lock（NICO_POS_FILE 同目录）flock(LOCK_EX|LOCK_NB)。
// 拿锁失败 = 已有存活实例在屏上——不抢不杀，stderr 说明后 exit(0)。fd 有意不关：
// 持锁存活整个进程，退出时内核自动释放，无陈锁问题。
let lockDir = ProcessInfo.processInfo.environment["NICO_POS_FILE"].map {
    NSString(string: $0).deletingLastPathComponent
} ?? NSString(string: "~/.dsh/nico").expandingTildeInPath
let lockPath = (lockDir as NSString).appendingPathComponent("bubble.lock")
try? FileManager.default.createDirectory(atPath: lockDir, withIntermediateDirectories: true)
let lockFD = open(lockPath, O_RDWR | O_CREAT, 0o644)
if lockFD >= 0 {
    if flock(lockFD, LOCK_EX | LOCK_NB) != 0 {
        FileHandle.standardError.write(Data("nico overlay: another instance is running; exiting\n".utf8))
        exit(0)
    }
} else {
    // lockFD < 0（打不开锁文件）：记 stderr 后继续跑——锁缺失只损失单实例保证，
    // 不该让 overlay 完全起不来。
    FileHandle.standardError.write(Data("nico overlay: open lock failed (\(errno)), running without single-instance lock\n".utf8))
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// Overlay 是 @MainActor：顶层（Swift 5 模式非隔离）经 assumeIsolated 在主线程创建。
let overlay = MainActor.assumeIsolated { Overlay() }
// stdin 线程只投递：主队列 FIFO 保证 op 顺序，assumeIsolated 进 MainActor。
startStdin { obj in
    DispatchQueue.main.async {
        MainActor.assumeIsolated {
            let op = obj["op"] as? String ?? ""
            if op == "close" {
                overlay.close()
            } else if op == "state" {
                overlay.apply(obj)
            } else if op == "show" {
                // 旧协议兼容：show → state=listening，expr 字段改名 exp。
                var o = obj
                o.removeValue(forKey: "op")
                o["state"] = "listening"
                if let e = o.removeValue(forKey: "expr") { o["exp"] = e }
                overlay.apply(o)
            }
        }
    }
}
app.run()
