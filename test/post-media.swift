import AppKit
let down = CommandLine.arguments.count < 2 || CommandLine.arguments[1] == "down"
let state = down ? 10 : 11
let data1 = (16 << 16) | (state << 8)
let ns = NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, subtype: 8, data1: data1, data2: 0)!
ns.cgEvent!.post(tap: .cgSessionEventTap)
Thread.sleep(forTimeInterval: 0.2)
