/**
 * macOS 辅助功能输入与剪贴板桥接 Swift 源码片段。
 */
export const MACOS_UI_BRIDGE_SWIFT = `import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

final class DesktopUiBridge {
    private var pressedButtons = Set<Int>()
    private var pressedKeys = Set<UInt16>()
    private var lastPoint = CGPoint(x: 200, y: 200)
    private let eventSource = CGEventSource(stateID: .hidSystemState)

    static func checkPermissions(prompt: Bool) -> (screenRecording: Bool, accessibility: Bool) {
        let screenOk: Bool
        if prompt {
            screenOk = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
        } else {
            screenOk = CGPreflightScreenCaptureAccess()
        }
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
        let axOk = AXIsProcessTrustedWithOptions(options)
        return (screenOk, axOk)
    }

    private func resolvePoint(normX: Double, normY: Double, bounds: CGRect) -> CGPoint {
        let clampedX = min(1.0, max(0.0, normX))
        let clampedY = min(1.0, max(0.0, normY))
        let w = max(1.0, bounds.width - 1.0)
        let h = max(1.0, bounds.height - 1.0)
        let pt = CGPoint(
            x: bounds.origin.x + clampedX * w,
            y: bounds.origin.y + clampedY * h
        )
        lastPoint = pt
        return pt
    }

    func movePointer(normX: Double, normY: Double, bounds: CGRect) {
        let pt = resolvePoint(normX: normX, normY: normY, bounds: bounds)
        let moveType: CGEventType
        let button: CGMouseButton
        if pressedButtons.contains(0) {
            moveType = .leftMouseDragged
            button = .left
        } else if pressedButtons.contains(2) {
            moveType = .rightMouseDragged
            button = .right
        } else if pressedButtons.contains(1) {
            moveType = .otherMouseDragged
            button = .center
        } else {
            moveType = .mouseMoved
            button = .left
        }
        guard let ev = CGEvent(mouseEventSource: eventSource, mouseType: moveType, mouseCursorPosition: pt, mouseButton: button) else {
            return
        }
        ev.post(tap: .cghidEventTap)
    }

    func mouseButton(down: Bool, buttonCode: Int, clicks: Int, normX: Double, normY: Double, bounds: CGRect) {
        let pt = resolvePoint(normX: normX, normY: normY, bounds: bounds)
        let type: CGEventType
        let cgButton: CGMouseButton
        switch buttonCode {
        case 2:
            type = down ? .rightMouseDown : .rightMouseUp
            cgButton = .right
        case 1:
            type = down ? .otherMouseDown : .otherMouseUp
            cgButton = .center
        default:
            type = down ? .leftMouseDown : .leftMouseUp
            cgButton = .left
        }
        if down {
            pressedButtons.insert(buttonCode)
        } else {
            pressedButtons.remove(buttonCode)
        }
        guard let ev = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: pt, mouseButton: cgButton) else {
            return
        }
        ev.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, clicks)))
        ev.post(tap: .cghidEventTap)
    }

    func scrollWheel(dx: Double, dy: Double, normX: Double?, normY: Double?, bounds: CGRect) {
        if let nx = normX, let ny = normY {
            _ = resolvePoint(normX: nx, normY: ny, bounds: bounds)
        }
        let vy = Int32((-dy).rounded())
        let vx = Int32((-dx).rounded())
        guard vx != 0 || vy != 0 else { return }
        guard let ev = CGEvent(
            scrollWheelEvent2Source: eventSource,
            units: .pixel,
            wheelCount: 2,
            wheel1: vy,
            wheel2: vx,
            wheel3: 0
        ) else { return }
        ev.location = lastPoint
        ev.post(tap: .cghidEventTap)
    }

    func keyEvent(keyCode: UInt16, down: Bool, meta: Bool?, ctrl: Bool?, alt: Bool?, shift: Bool?) {
        if down {
            pressedKeys.insert(keyCode)
        } else {
            pressedKeys.remove(keyCode)
        }
        guard let ev = CGEvent(keyboardEventSource: eventSource, virtualKey: CGKeyCode(keyCode), keyDown: down) else {
            return
        }
        var flags = ev.flags
        if let meta {
            if meta { flags.insert(.maskCommand) } else { flags.remove(.maskCommand) }
        }
        if let ctrl {
            if ctrl { flags.insert(.maskControl) } else { flags.remove(.maskControl) }
        }
        if let alt {
            if alt { flags.insert(.maskAlternate) } else { flags.remove(.maskAlternate) }
        }
        if let shift {
            if shift { flags.insert(.maskShift) } else { flags.remove(.maskShift) }
        }
        ev.flags = flags
        ev.post(tap: .cghidEventTap)
    }

    func insertText(_ text: String) {
        guard !text.isEmpty else { return }
        let utf16 = Array(text.utf16)
        var offset = 0
        let chunkSize = 16
        while offset < utf16.count {
            let end = min(utf16.count, offset + chunkSize)
            var slice = Array(utf16[offset..<end])
            if let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true),
               let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: false) {
                down.keyboardSetUnicodeString(stringLength: slice.count, unicodeString: &slice)
                up.keyboardSetUnicodeString(stringLength: slice.count, unicodeString: &slice)
                down.post(tap: .cghidEventTap)
                up.post(tap: .cghidEventTap)
            }
            offset = end
        }
    }

    func readClipboard() -> String {
        return NSPasteboard.general.string(forType: .string) ?? ""
    }

    func writeClipboard(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
    }

    func releaseAll() {
        for btn in Array(pressedButtons) {
            let cgButton: CGMouseButton = btn == 2 ? .right : (btn == 1 ? .center : .left)
            let upType: CGEventType = btn == 2 ? .rightMouseUp : (btn == 1 ? .otherMouseUp : .leftMouseUp)
            if let ev = CGEvent(mouseEventSource: eventSource, mouseType: upType, mouseCursorPosition: lastPoint, mouseButton: cgButton) {
                ev.post(tap: .cghidEventTap)
            }
        }
        pressedButtons.removeAll()
        for key in Array(pressedKeys) {
            if let ev = CGEvent(keyboardEventSource: eventSource, virtualKey: CGKeyCode(key), keyDown: false) {
                ev.post(tap: .cghidEventTap)
            }
        }
        pressedKeys.removeAll()
    }
}
`;
