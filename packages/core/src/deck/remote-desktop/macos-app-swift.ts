/**
 * `U-Brain Remote Host.app` 入口与本地双通道 IPC（JSON 控制流 + 二进制 H.264 帧流）。
 */
export const MACOS_REMOTE_HOST_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>UBrainRemoteHost</string>
  <key>CFBundleIdentifier</key><string>app.you-brain.remote-host</string>
  <key>CFBundleName</key><string>U-Brain Remote Host</string>
  <key>CFBundleDisplayName</key><string>U-Brain Remote Host</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>NSScreenCaptureUsageDescription</key><string>允许同账号已授权设备在指挥台中查看当前 Mac 桌面画面。</string>
</dict></plist>
`;

export const MACOS_REMOTE_HOST_APP_SWIFT = `import AppKit
import CoreGraphics
import Darwin
import Foundation

private func connectLocalSocket(_ path: String) -> Int32 {
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return -1 }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let utf8 = Array(path.utf8)
    let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
    guard utf8.count < maxLen else { Darwin.close(fd); return -1 }
    withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
        ptr.withMemoryRebound(to: UInt8.self, capacity: maxLen) { dst in
            dst.initialize(repeating: 0, count: maxLen)
            for (i, byte) in utf8.enumerated() { dst[i] = byte }
        }
    }
    let len = socklen_t(MemoryLayout<sockaddr_un>.size)
    let rc = withUnsafePointer(to: &addr) { ptr in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
            Darwin.connect(fd, sa, len)
        }
    }
    guard rc == 0 else { Darwin.close(fd); return -1 }
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    return fd
}

private func writeAll(_ fd: Int32, _ data: Data) -> Bool {
    guard fd >= 0 else { return false }
    return data.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { return true }
        var offset = 0
        while offset < data.count {
            let n = Darwin.write(fd, base.advanced(by: offset), data.count - offset)
            if n <= 0 {
                if errno == EINTR { continue }
                return false
            }
            offset += n
        }
        return true
    }
}

final class RemoteHostAppDelegate: NSObject, NSApplicationDelegate {
    private var ctrlFD: Int32 = -1
    private var videoFD: Int32 = -1
    private let ctrlWriteLock = NSLock()
    private let videoWriteLock = NSLock()
    private let capture = ScreenCapturePipeline()
    private let ui = DesktopUiBridge()
    private var currentBounds: CGRect = CGDisplayBounds(CGMainDisplayID())
    private var stopping = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        guard let cIdx = args.firstIndex(of: "--ctrl"), cIdx + 1 < args.count,
              let vIdx = args.firstIndex(of: "--video"), vIdx + 1 < args.count else {
            NSApplication.shared.terminate(nil)
            return
        }
        ctrlFD = connectLocalSocket(args[cIdx + 1])
        videoFD = connectLocalSocket(args[vIdx + 1])
        guard ctrlFD >= 0, videoFD >= 0 else {
            shutdown()
            return
        }

        capture.onEncodedFrame = { [weak self] keyframe, ptsUs, sps, pps, avcc in
            self?.sendVideoFrame(keyframe: keyframe, ptsUs: ptsUs, sps: sps, pps: pps, avcc: avcc)
        }
        capture.onError = { [weak self] message in
            self?.emitCtrl(["ev": "error", "message": message])
        }

        let displays = ScreenCapturePipeline.enumerateDisplays()
        let mainId = CGMainDisplayID()
        if let active = displays.first(where: { $0.id == mainId }) ?? displays.first {
            currentBounds = active.frame
        }
        let perms = DesktopUiBridge.checkPermissions(prompt: false)
        emitCtrl([
            "ev": "ready",
            "displays": displays.map { $0.toJSON() },
            "activeDisplayId": Int(displays.first(where: { $0.primary })?.id ?? displays.first?.id ?? mainId),
            "permissions": [
                "screenRecording": perms.screenRecording,
                "accessibility": perms.accessibility,
            ],
        ])

        let fd = ctrlFD
        DispatchQueue.global(qos: .userInteractive).async { [weak self] in
            var buffer = Data()
            var scratch = [UInt8](repeating: 0, count: 8192)
            while true {
                let n = Darwin.read(fd, &scratch, scratch.count)
                if n <= 0 {
                    if n < 0 && errno == EINTR { continue }
                    DispatchQueue.main.async { self?.shutdown() }
                    return
                }
                buffer.append(contentsOf: scratch[0..<n])
                if buffer.count > 524_288 {
                    DispatchQueue.main.async { self?.shutdown() }
                    return
                }
                while let nl = buffer.firstIndex(of: 10) {
                    let line = Data(buffer[..<nl])
                    buffer.removeSubrange(...nl)
                    if line.isEmpty { continue }
                    if let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
                        self?.handleCommand(obj)
                    }
                }
            }
        }
    }

    private func emitCtrl(_ payload: [String: Any]) {
        guard let json = try? JSONSerialization.data(withJSONObject: payload) else { return }
        var line = json
        line.append(10)
        ctrlWriteLock.lock()
        let ok = writeAll(ctrlFD, line)
        ctrlWriteLock.unlock()
        if !ok {
            DispatchQueue.main.async { self.shutdown() }
        }
    }

    private func sendVideoFrame(keyframe: Bool, ptsUs: UInt64, sps: Data?, pps: Data?, avcc: Data) {
        let spsData = sps ?? Data()
        let ppsData = pps ?? Data()
        guard spsData.count <= 65535, ppsData.count <= 65535 else { return }
        var header = Data(capacity: 24 + spsData.count + ppsData.count + avcc.count)
        header.append(contentsOf: [0x55, 0x42, 0x52, 0x44]) // "UBRD"
        var flagsBE = UInt32(keyframe ? 1 : 0).bigEndian
        var ptsBE = ptsUs.bigEndian
        var spsLenBE = UInt16(spsData.count).bigEndian
        var ppsLenBE = UInt16(ppsData.count).bigEndian
        var avccLenBE = UInt32(avcc.count).bigEndian
        withUnsafeBytes(of: &flagsBE) { header.append(contentsOf: $0) }
        withUnsafeBytes(of: &ptsBE) { header.append(contentsOf: $0) }
        withUnsafeBytes(of: &spsLenBE) { header.append(contentsOf: $0) }
        withUnsafeBytes(of: &ppsLenBE) { header.append(contentsOf: $0) }
        withUnsafeBytes(of: &avccLenBE) { header.append(contentsOf: $0) }
        header.append(spsData)
        header.append(ppsData)
        header.append(avcc)

        videoWriteLock.lock()
        let ok = writeAll(videoFD, header)
        videoWriteLock.unlock()
        if !ok {
            DispatchQueue.main.async { self.shutdown() }
        }
    }

    private func handleCommand(_ cmd: [String: Any]) {
        guard let op = cmd["op"] as? String else { return }
        switch op {
        case "mm":
            guard let x = cmd["x"] as? Double, let y = cmd["y"] as? Double else { return }
            ui.movePointer(normX: x, normY: y, bounds: currentBounds)
        case "wh":
            let dx = (cmd["dx"] as? Double) ?? 0
            let dy = (cmd["dy"] as? Double) ?? 0
            let nx = cmd["x"] as? Double
            let ny = cmd["y"] as? Double
            ui.scrollWheel(dx: dx, dy: dy, normX: nx, normY: ny, bounds: currentBounds)
        case "md", "mu":
            guard let x = cmd["x"] as? Double, let y = cmd["y"] as? Double else { return }
            let b = (cmd["b"] as? Int) ?? 0
            let clicks = (cmd["clicks"] as? Int) ?? 1
            ui.mouseButton(down: op == "md", buttonCode: b, clicks: clicks, normX: x, normY: y, bounds: currentBounds)
        case "kd", "ku":
            guard let keyCode = cmd["keyCode"] as? Int, keyCode >= 0, keyCode <= 255 else { return }
            ui.keyEvent(
                keyCode: UInt16(keyCode),
                down: op == "kd",
                meta: cmd["meta"] as? Bool,
                ctrl: cmd["ctrl"] as? Bool,
                alt: cmd["alt"] as? Bool,
                shift: cmd["shift"] as? Bool
            )
        case "txt":
            if let text = cmd["text"] as? String {
                ui.insertText(text)
            }
        case "idr":
            capture.requestKeyframe()
        case "cb.get":
            DispatchQueue.main.async {
                let text = self.ui.readClipboard()
                self.emitCtrl(["ev": "cb", "text": text])
            }
        case "cb.set":
            if let text = cmd["text"] as? String {
                DispatchQueue.main.async {
                    self.ui.writeClipboard(text)
                }
            }
        case "perm":
            let prompt = (cmd["prompt"] as? Bool) ?? true
            DispatchQueue.main.async {
                let perms = DesktopUiBridge.checkPermissions(prompt: prompt)
                let displays = ScreenCapturePipeline.enumerateDisplays()
                let activeId = self.capture.activeDisplay()?.id ?? displays.first?.id ?? CGMainDisplayID()
                self.emitCtrl([
                    "ev": "state",
                    "displays": displays.map { $0.toJSON() },
                    "activeDisplayId": Int(activeId),
                    "permissions": [
                        "screenRecording": perms.screenRecording,
                        "accessibility": perms.accessibility,
                    ],
                ])
            }
        case "configure":
            let displayIdNum = cmd["displayId"] as? Int
            let maxDimension = (cmd["maxDimension"] as? Int) ?? 1920
            let fps = (cmd["fps"] as? Int) ?? 60
            let bitrateBps = (cmd["bitrateBps"] as? Int) ?? 8_500_000
            let prompt = (cmd["prompt"] as? Bool) ?? false
            DispatchQueue.main.async {
                let perms = DesktopUiBridge.checkPermissions(prompt: prompt)
                let reqDisplay = displayIdNum.map { CGDirectDisplayID($0) }
                self.capture.startOrUpdate(
                    displayId: reqDisplay,
                    maxDimension: maxDimension,
                    fps: fps,
                    bitrateBps: bitrateBps
                ) { activeId, displays in
                    if let matched = displays.first(where: { $0.id == activeId }) {
                        self.currentBounds = matched.frame
                    }
                    let refreshedPerms = DesktopUiBridge.checkPermissions(prompt: false)
                    self.emitCtrl([
                        "ev": "state",
                        "displays": displays.map { $0.toJSON() },
                        "activeDisplayId": Int(activeId),
                        "permissions": [
                            "screenRecording": perms.screenRecording || refreshedPerms.screenRecording,
                            "accessibility": perms.accessibility || refreshedPerms.accessibility,
                        ],
                    ])
                }
            }
        case "release":
            ui.releaseAll()
        case "stop":
            DispatchQueue.main.async { self.shutdown() }
        default:
            break
        }
    }

    func shutdown() {
        guard !stopping else { return }
        stopping = true
        ui.releaseAll()
        capture.stop()
        ctrlWriteLock.lock()
        if ctrlFD >= 0 { Darwin.close(ctrlFD); ctrlFD = -1 }
        ctrlWriteLock.unlock()
        videoWriteLock.lock()
        if videoFD >= 0 { Darwin.close(videoFD); videoFD = -1 }
        videoWriteLock.unlock()
        NSApplication.shared.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        ui.releaseAll()
        capture.stop()
    }
}

let app = NSApplication.shared
let delegate = RemoteHostAppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
`;
