/**
 * macOS 辅助功能输入、剪贴板、光标形状与电源管理桥接 Swift 源码片段。
 */
export const MACOS_UI_BRIDGE_SWIFT = `import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Foundation
import IOKit.pwr_mgt

final class DesktopUiBridge {
    private var pressedButtons = Set<Int>()
    private var pressedKeys = Set<UInt16>()
    private var lastPoint = CGPoint(x: 200, y: 200)
    private var scrollRemainderX = 0.0
    private var scrollRemainderY = 0.0
    private let eventSource = CGEventSource(stateID: .hidSystemState)
    /** 宿主自己写入剪贴板后的 changeCount，监听器据此忽略回声。 */
    var ownPasteboardChangeCount: Int = -1

    init() {
        // 合成事件不应被本机物理按键的修饰键状态污染。
        eventSource?.localEventsSuppressionInterval = 0
    }

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
        // 累积小数部分：触控板细粒度滚动不再被取整吞掉。
        // 协议里的 dx/dy 已是 CGEvent 方向（正值 = 向上/向左滚），控制端已完成取反，这里不能再取反。
        scrollRemainderY += dy
        scrollRemainderX += dx
        let vy = Int32(scrollRemainderY.rounded(.towardZero))
        let vx = Int32(scrollRemainderX.rounded(.towardZero))
        scrollRemainderY -= Double(vy)
        scrollRemainderX -= Double(vx)
        guard vx != 0 || vy != 0 else { return }
        guard let ev = CGEvent(
            scrollWheelEvent2Source: eventSource,
            units: .pixel,
            wheelCount: 2,
            wheel1: vy,
            wheel2: vx,
            wheel3: 0
        ) else { return }
        ev.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        ev.location = lastPoint
        ev.post(tap: .cghidEventTap)
    }

    func keyEvent(keyCode: UInt16, down: Bool, meta: Bool?, ctrl: Bool?, alt: Bool?, shift: Bool?, repeatKey: Bool = false) {
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
        // 方向键与功能键需要带 NumericPad / SecondaryFn 标记，部分应用据此识别。
        if (0x7b...0x7e).contains(keyCode) {
            flags.insert(.maskNumericPad)
            flags.insert(.maskSecondaryFn)
        } else if [0x72, 0x73, 0x74, 0x75, 0x77, 0x79].contains(keyCode) || DesktopUiBridge.functionKeys.contains(keyCode) {
            flags.insert(.maskSecondaryFn)
        }
        ev.flags = flags
        if repeatKey && down {
            ev.setIntegerValueField(.keyboardEventAutorepeat, value: 1)
        }
        ev.post(tap: .cghidEventTap)
    }

    private static let functionKeys: Set<UInt16> = [
        0x7a, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6d, 0x67, 0x6f,
        0x69, 0x6b, 0x71, 0x6a, 0x40, 0x4f, 0x50, 0x5a,
    ]

    /** 当前输入源是否为纯键盘布局（ABC、US 等）。中文/日文等输入法返回 false。 */
    static func currentInputSourceIsPlainLayout() -> Bool {
        guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() else { return true }
        guard let raw = TISGetInputSourceProperty(source, kTISPropertyInputSourceType) else { return true }
        let type = Unmanaged<CFString>.fromOpaque(raw).takeUnretainedValue() as String
        return type == (kTISTypeKeyboardLayout as String)
    }

    /**
     * 文本直输。远端为普通键盘布局时用 Unicode 键盘事件逐字注入（不碰剪贴板）；
     * 远端正在使用输入法时，Unicode 事件会被输入法截获成拼音，改走「写剪贴板 + ⌘V + 恢复剪贴板」。
     * 必须在主线程调用。
     */
    func insertText(_ text: String) {
        guard !text.isEmpty else { return }
        if DesktopUiBridge.currentInputSourceIsPlainLayout() && !text.contains("\\n") {
            postUnicode(text)
        } else {
            pasteText(text)
        }
    }

    private func postUnicode(_ text: String) {
        // 按字素切片，避免把 emoji 代理对拆开；每个事件最多 16 个 UTF-16 单元。
        var batch: [UInt16] = []
        func flush() {
            guard !batch.isEmpty else { return }
            var slice = batch
            if let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true),
               let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: false) {
                down.flags = []
                up.flags = []
                down.keyboardSetUnicodeString(stringLength: slice.count, unicodeString: &slice)
                up.keyboardSetUnicodeString(stringLength: slice.count, unicodeString: &slice)
                down.post(tap: .cghidEventTap)
                up.post(tap: .cghidEventTap)
            }
            batch.removeAll(keepingCapacity: true)
        }
        for ch in text {
            let units = Array(String(ch).utf16)
            if batch.count + units.count > 16 { flush() }
            batch.append(contentsOf: units)
        }
        flush()
    }

    private func snapshotPasteboard(_ pb: NSPasteboard) -> [[NSPasteboard.PasteboardType: Data]] {
        guard let items = pb.pasteboardItems else { return [] }
        return items.map { item in
            var dict: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) { dict[type] = data }
            }
            return dict
        }
    }

    private func restorePasteboard(_ pb: NSPasteboard, _ saved: [[NSPasteboard.PasteboardType: Data]]) {
        pb.clearContents()
        let items: [NSPasteboardItem] = saved.map { dict in
            let item = NSPasteboardItem()
            for (type, data) in dict { item.setData(data, forType: type) }
            return item
        }
        if !items.isEmpty { pb.writeObjects(items) }
        ownPasteboardChangeCount = pb.changeCount
    }

    private func pasteText(_ text: String) {
        let pb = NSPasteboard.general
        let saved = snapshotPasteboard(pb)
        pb.clearContents()
        pb.setString(text, forType: .string)
        let ours = pb.changeCount
        ownPasteboardChangeCount = ours
        if let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0x09, keyDown: true),
           let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 0x09, keyDown: false) {
            down.flags = .maskCommand
            up.flags = .maskCommand
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
        // 给目标应用留出读取剪贴板的时间，之后恢复用户原来的剪贴板内容。
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self] in
            guard let self else { return }
            if pb.changeCount == ours {
                self.restorePasteboard(pb, saved)
            }
        }
    }

    func readClipboard() -> String {
        return NSPasteboard.general.string(forType: .string) ?? ""
    }

    func writeClipboard(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        ownPasteboardChangeCount = pb.changeCount
    }

    /** 写入任意格式图片（PNG/JPEG/GIF/HEIC 等），统一转成 PNG + TIFF，各类应用都能粘贴。 */
    func writeClipboardImage(_ data: Data) {
        guard let png = DesktopUiBridge.pngData(from: data) else { return }
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setData(png, forType: .png)
        if let rep = NSBitmapImageRep(data: png), let tiff = rep.tiffRepresentation {
            pb.setData(tiff, forType: .tiff)
        }
        ownPasteboardChangeCount = pb.changeCount
    }

    static func pngData(from data: Data) -> Data? {
        if data.count >= 8, data.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return data }
        if let rep = NSBitmapImageRep(data: data), let png = rep.representation(using: .png, properties: [:]) {
            return png
        }
        guard let image = NSImage(data: data), let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }

    /** 剪贴板只有图片（没有文字和文件）时返回像素尺寸。 */
    static func clipboardImageInfo(_ pb: NSPasteboard = .general) -> (Int, Int)? {
        guard pb.availableType(from: [.png, .tiff]) != nil else { return nil }
        if let data = pb.data(forType: .png) ?? pb.data(forType: .tiff), let rep = NSBitmapImageRep(data: data) {
            return (rep.pixelsWide, rep.pixelsHigh)
        }
        guard let image = NSImage(pasteboard: pb) else { return nil }
        return (Int(image.size.width), Int(image.size.height))
    }

    func readClipboardImagePng() -> Data? {
        let pb = NSPasteboard.general
        if let png = pb.data(forType: .png) { return png }
        guard let tiff = pb.data(forType: .tiff), let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
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
                ev.flags = []
                ev.post(tap: .cghidEventTap)
            }
        }
        pressedKeys.removeAll()
        scrollRemainderX = 0
        scrollRemainderY = 0
    }
}

/** 轮询远端剪贴板 changeCount，变化时上报文本或复制的文件列表。主线程运行。 */
final class ClipboardWatcher {
    private var timer: Timer?
    private var lastChangeCount = NSPasteboard.general.changeCount
    var onChange: (([String: Any]) -> Void)?
    weak var ui: DesktopUiBridge?

    var isRunning: Bool { timer != nil }

    func start() {
        guard timer == nil else { return }
        lastChangeCount = NSPasteboard.general.changeCount
        let t = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in self?.poll() }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func poll() {
        let pb = NSPasteboard.general
        let count = pb.changeCount
        guard count != lastChangeCount else { return }
        lastChangeCount = count
        if let ui, ui.ownPasteboardChangeCount == count { return }
        var payload: [String: Any] = ["ev": "cb", "auto": true]
        let urls = (pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
        if !urls.isEmpty {
            var files: [[String: Any]] = []
            for url in urls.prefix(50) {
                var isDir: ObjCBool = false
                guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), !isDir.boolValue else { continue }
                let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0
                files.append(["path": url.path, "name": url.lastPathComponent, "size": size])
            }
            if !files.isEmpty { payload["files"] = files }
        }
        if let text = pb.string(forType: .string), !text.isEmpty {
            payload["text"] = text
        } else if payload["files"] != nil {
            payload["text"] = ""
        } else if let (w, h) = DesktopUiBridge.clipboardImageInfo(pb) {
            // 只上报尺寸，图片数据由控制端按需拉取，避免每次复制都搬运整张图。
            payload["text"] = ""
            payload["image"] = ["w": w, "h": h]
        } else {
            return
        }
        onChange?(payload)
    }
}

/** 轮询当前系统光标形状，变化时上报 PNG 与热点，供控制端本地渲染零延迟光标。主线程运行。 */
final class CursorShapeMonitor {
    private var timer: Timer?
    private var lastSignature: UInt64 = 0
    var onChange: (([String: Any]) -> Void)?

    func start() {
        guard timer == nil else { return }
        lastSignature = 0
        let t = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in self?.poll() }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        poll()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func resend() {
        lastSignature = 0
        poll()
    }

    private func poll() {
        guard let cursor = NSCursor.currentSystem else { return }
        let image = cursor.image
        let size = image.size
        guard size.width > 0, size.height > 0,
              let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
        let hotspot = cursor.hotSpot
        var sig: UInt64 = 1469598103934665603
        func mix(_ v: UInt64) { sig = (sig ^ v) &* 1099511628211 }
        mix(UInt64(cg.width)); mix(UInt64(cg.height))
        mix(UInt64(bitPattern: Int64(hotspot.x * 100))); mix(UInt64(bitPattern: Int64(hotspot.y * 100)))
        if let data = cg.dataProvider?.data, let ptr = CFDataGetBytePtr(data) {
            let len = CFDataGetLength(data)
            var i = 0
            // 每 4 字节采样一次足以区分光标形状，且 30Hz 轮询开销可忽略。
            while i < len {
                mix(UInt64(ptr[i]))
                i += 4
            }
        }
        guard sig != lastSignature else { return }
        lastSignature = sig
        let rep = NSBitmapImageRep(cgImage: cg)
        guard let png = rep.representation(using: .png, properties: [:]) else { return }
        onChange?([
            "ev": "cursor",
            "png": png.base64EncodedString(),
            "hx": Double(hotspot.x),
            "hy": Double(hotspot.y),
            "w": Double(size.width),
            "h": Double(size.height),
        ])
    }
}

/** 远程会话期间阻止显示器休眠，并在开始时唤醒屏幕。 */
final class DisplayWakeGuard {
    private var assertionId: IOPMAssertionID = 0
    private var active = false

    func engage() {
        var userActivity: IOPMAssertionID = 0
        IOPMAssertionDeclareUserActivity("U-Brain 远程桌面" as CFString, kIOPMUserActiveLocal, &userActivity)
        guard !active else { return }
        let result = IOPMAssertionCreateWithName(
            kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn),
            "U-Brain 远程桌面会话进行中" as CFString,
            &assertionId
        )
        active = result == kIOReturnSuccess
    }

    func release() {
        guard active else { return }
        IOPMAssertionRelease(assertionId)
        active = false
    }
}
`;
