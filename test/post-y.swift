import AppKit
let down = CommandLine.arguments.count > 1 && CommandLine.arguments[1] == "down"
let event = CGEvent(keyboardEventSource: nil, virtualKey: 16, keyDown: down)!
event.post(tap: .cgSessionEventTap)
Thread.sleep(forTimeInterval: 0.2)
