// nico bubble — a floating "recording" overlay for dsh-nico.
//
// A borderless, non-activating NSPanel that the parasite spawns and drives over
// stdin (one JSON op per line). It composites as a real WindowServer window on
// macOS 27 (verified: CGWindowList reports non-zero bounds, isOnscreen=true) —
// the PyObjC / AppleScript "make new window" routes are both dead there.
//
// Protocol (stdin, line-delimited JSON):
//   {"op":"show","text":"🎙 录音中…"}   show (or update text of) the bubble
//   {"op":"close"}                     hide + exit 0
//
// Zero grants, zero deps: an accessory NSPanel needs no TCC to draw, and a
// borderless window that never activates steals no focus from the host.

import Cocoa
import Foundation

final class BubbleController: NSObject {
    let panel: NSPanel
    let label: NSTextField
    let sub: NSTextField

    override init() {
        let size = NSSize(width: 300, height: 150)
        panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        label = NSTextField(labelWithString: "🎙 录音中…")
        sub = NSTextField(labelWithString: "松手结束 · 右⌘ 按住说话")
        super.init()
        configure()
    }

    func configure() {
        panel.level = .statusBar
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .stationary]
        panel.hasShadow = true
        panel.title = "nico"
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false

        let bg = BubbleBackgroundView(frame: NSRect(origin: .zero, size: panel.contentView!.bounds.size))
        bg.wantsLayer = true
        bg.layer?.cornerRadius = 28
        bg.layer?.backgroundColor = NSColor(calibratedRed: 0.04, green: 0.06, blue: 0.11, alpha: 0.96).cgColor
        panel.contentView = bg

        label.frame = NSRect(x: 16, y: 56, width: 300 - 32, height: 66)
        label.font = .systemFont(ofSize: 17, weight: .semibold)
        label.textColor = .white
        label.alignment = .center
        label.maximumNumberOfLines = 3
        label.lineBreakMode = .byCharWrapping
        label.cell?.wraps = true
        label.cell?.isScrollable = false
        label.preferredMaxLayoutWidth = 300 - 32
        bg.addSubview(label)

        sub.frame = NSRect(x: 16, y: 34, width: 300 - 32, height: 22)
        sub.font = .systemFont(ofSize: 13)
        sub.textColor = NSColor(calibratedRed: 0.72, green: 0.76, blue: 0.86, alpha: 1)
        sub.alignment = .center
        bg.addSubview(sub)

        positionTopRight()
    }

    // Top-right of the main display's visible frame (48pt margin). NSScreen.main
    // can be nil for an accessory app, so fall back to the first screen.
    func positionTopRight() {
        let s = NSScreen.main ?? NSScreen.screens.first
        guard let sc = s else { return }
        let vf = sc.visibleFrame
        let margin: CGFloat = 48
        let x = vf.origin.x + vf.size.width - 300 - margin
        let y = vf.origin.y + vf.size.height - 150 - margin
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    func show(_ text: String?) {
        DispatchQueue.main.async {
            if let t = text, !t.isEmpty { self.label.stringValue = t }
            self.positionTopRight()
            self.panel.orderFrontRegardless()
        }
    }

    func close() {
        DispatchQueue.main.async {
            self.panel.orderOut(nil)
            exit(0)
        }
    }

    // Read stdin on a detached thread (DispatchSource's per-file API is unstable
    // in Swift 6.4 here); UI mutations hop to the main queue. One JSON per line;
    // partial lines are buffered until a newline arrives.
    func startStdin() {
        Thread.detachNewThread { [weak self] in
            guard let self = self else { return }
            var line = ""
            while let str = String(data: FileHandle.standardInput.availableData, encoding: .utf8), !str.isEmpty {
                line += str
                while let nl = line.firstIndex(of: "\n") {
                    let cmd = String(line[line.startIndex..<nl]).trimmingCharacters(in: .whitespaces)
                    line = String(line[line.index(after: nl)...])
                    guard !cmd.isEmpty else { continue }
                    if let obj = try? JSONSerialization.jsonObject(with: Data(cmd.utf8)) as? [String: Any] {
                        let op = obj["op"] as? String ?? ""
                        if op == "show" { self.show(obj["text"] as? String) }
                        else if op == "close" { self.close(); return }
                    }
                }
            }
            self.close()
        }
    }
}

class BubbleBackgroundView: NSView {
    override var isFlipped: Bool { false }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let ctrl = BubbleController()
ctrl.startStdin()
app.run()
