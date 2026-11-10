#!/usr/bin/env python3
"""dsh-nico floating bubble — a tiny always-on-top NSPanel driven over stdio.

Parent (the nico parasite in the DSH host) spawns this and writes JSON lines to
its stdin:
    {"op":"show","text":"🎙 录音中…"}
    {"op":"close"}
A single borderless, transparent, non-activating window at NSStatusWindowLevel
floats above everything, joins all Spaces + full-screen, ignores the mouse (it is
a passive indicator). The same window is reused for 录音中 / 识别中 / 执行中 states.

If PyObjC / AppKit is missing (a host without the GUI stack), it degrades to a
quiet no-op: drain stdin, exit 0 — the hold-to-talk loop never breaks.
"""
import sys, json, select

def main():
    try:
        import AppKit
        from AppKit import (
            NSApplication, NSWindow, NSBackingStoreBuffered,
            NSStatusWindowLevel, NSColor, NSFont, NSScreen, NSBezierPath,
            NSTextField,
        )
        from Foundation import NSObject, NSRunLoop
        NSMakeRect = AppKit.NSMakeRect
    except Exception:
        sys.stdin.read()
        return 0

    app = NSApplication.sharedApplication()
    # Accessory: no Dock icon, no menu bar, never steals focus.
    app.setActivationPolicy_(0)

    W, H = 300, 150
    vf = NSScreen.screens()[0].visibleFrame()
    x = vf.origin.x + vf.size.width - W - 48
    y = vf.origin.y + vf.size.height - H - 72

    win = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
        NSMakeRect(x, y, W, H), 0, NSBackingStoreBuffered, False)
    win.setLevel_(NSStatusWindowLevel)
    win.setOpaque_(False)
    win.setBackgroundColor_(NSColor.colorWithRed_green_blue_alpha_(0, 0, 0, 0))
    win.setIgnoresMouseEvents_(True)
    # CanJoinAllSpaces | FullScreenAuxiliary | Transient | Stationary
    win.setCollectionBehavior_(1 | 16 | 8 | 64)
    win.setHasShadow_(True)
    win.setTitle_("nico")

    # Rounded dark bubble background drawn into the content view.
    NSColor.colorWithRed_green_blue_alpha_(0.04, 0.06, 0.11, 0.94).set()
    NSBezierPath.bezierPathWithRoundedRect_xRadius_yRadius_(
        NSMakeRect(0, 0, W, H), 28, 28).fill()

    label = NSTextField.alloc().initWithFrame_(NSMakeRect(16, 80, W - 32, 44))
    for a in ("setEditable_", "setSelectable_", "setBordered_", "setBezeled_", "setDrawsBackground_"):
        getattr(label, a)(False)
    label.setStringValue_("🎙 录音中…")
    label.setFont_(NSFont.boldSystemFontOfSize_(30))
    label.setTextColor_(NSColor.whiteColor())
    label.setAlignment_(2)
    win.contentView().addSubview_(label)

    sub = NSTextField.alloc().initWithFrame_(NSMakeRect(16, 34, W - 32, 22))
    for a in ("setEditable_", "setSelectable_", "setBordered_", "setBezeled_", "setDrawsBackground_"):
        getattr(sub, a)(False)
    sub.setStringValue_("松手结束 · 右⌘ 按住说话")
    sub.setFont_(NSFont.systemFontOfSize_(13))
    sub.setTextColor_(NSColor.colorWithRed_green_blue_alpha_(0.72, 0.76, 0.86, 1))
    sub.setAlignment_(2)
    win.contentView().addSubview_(sub)

    state = {"shown": False, "done": False}

    def show(text=None):
        if text:
            label.setStringValue_(text)
        win.orderFrontRegardless()
        state["shown"] = True

    def close():
        if state["shown"]:
            win.close()
        state["done"] = True
        app.terminate_(None)

    # Drain commands buffered before the loop (one-shot callers still work).
    for line in list(iter(sys.stdin.readline, "")):
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except Exception:
            continue
        if cmd.get("op") == "show":
            show(cmd.get("text"))
        elif cmd.get("op") == "close":
            close()
            return 0

    # Serve interactive commands from the main run loop. tick() polls stdin
    # non-blocking, handles one line, then reschedules itself at 50ms — the
    # PyObjC-portable equivalent of a repeating NSTimer. close() flips done and
    # terminates, which stops app.run().
    class Bubble(NSObject):
        def tick(self):
            if state["done"]:
                return
            r, _, _ = select.select([sys.stdin], [], [], 0)
            if r:
                line = sys.stdin.readline()
                if not line:
                    close()
                    return
                line = line.strip()
                if line:
                    try:
                        cmd = json.loads(line)
                    except Exception:
                        pass
                    else:
                        if cmd.get("op") == "show":
                            show(cmd.get("text"))
                        elif cmd.get("op") == "close":
                            close()
            if not state["done"]:
                NSRunLoop.mainRunLoop().performSelectorWithObject_afterDelay_(
                    "tick", None, 0.05)

    controller = Bubble.alloc().init()
    NSRunLoop.mainRunLoop().performSelectorWithObject_afterDelay_("tick", None, 0.05)
    app.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
