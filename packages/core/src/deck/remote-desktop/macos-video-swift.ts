/**
 * macOS ScreenCaptureKit + VideoToolbox 60fps 零 B 帧硬件编码管线 Swift 源码片段。
 * 保持独立媒体模块，供 `U-Brain Remote Host.app` 编译时组合。
 *
 * 低延迟要点：
 * - 关键帧只在开流、切换、丢包（PLI/FIR）时按需产生，长 GOP 避免每 2 秒一次的大 IDR 突发卡顿；
 * - 编码积压超过 2 帧直接丢弃新帧，永不排队累积延迟；
 * - 码率可在会话中无关键帧地动态调整（弱网自适应）；
 * - 控制端本地渲染光标时光标不进画面，鼠标移动不再触发整帧编码。
 */
export const MACOS_VIDEO_PIPELINE_SWIFT = `import AppKit
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import VideoToolbox

struct DisplayDescriptor {
    let id: CGDirectDisplayID
    let name: String
    let width: Int
    let height: Int
    let scaleFactor: Double
    let primary: Bool
    let frame: CGRect

    func toJSON() -> [String: Any] {
        return [
            "id": Int(id),
            "name": name,
            "width": width,
            "height": height,
            "scaleFactor": scaleFactor,
            "primary": primary,
        ]
    }
}

final class HardwareH264Encoder {
    private var session: VTCompressionSession?
    private var width: Int32 = 0
    private var height: Int32 = 0
    private var bitrateBps: Int = 8_500_000
    private var fps: Int = 60
    private var forceNextKeyframe = true
    private var inFlight = 0
    private let queue = DispatchQueue(label: "app.you-brain.rd.encoder", qos: .userInteractive)
    var onEncodedFrame: ((Bool, UInt64, Data?, Data?, Data) -> Void)?
    /** 诊断计数（累计）：积压跳过、VideoToolbox 丢帧（多为码率上限所致）、编码输出。 */
    private let countersLock = NSLock()
    private var busySkipped = 0
    private var vtDropped = 0
    private var encodedCount = 0

    func counters() -> (busy: Int, dropped: Int, encoded: Int) {
        countersLock.lock()
        defer { countersLock.unlock() }
        return (busySkipped, vtDropped, encodedCount)
    }

    private func bump(_ apply: () -> Void) {
        countersLock.lock()
        apply()
        countersLock.unlock()
    }

    func configure(width: Int32, height: Int32, fps: Int, bitrateBps: Int) {
        queue.sync {
            let evenW = max(64, width & ~1)
            let evenH = max(64, height & ~1)
            if self.session != nil && self.width == evenW && self.height == evenH {
                if self.bitrateBps != bitrateBps || self.fps != fps {
                    self.bitrateBps = bitrateBps
                    self.fps = fps
                    self.applyDynamicRates()
                }
                self.forceNextKeyframe = true
                return
            }
            self.teardownLocked()
            self.width = evenW
            self.height = evenH
            self.fps = fps
            self.bitrateBps = bitrateBps
            self.createSessionLocked()
        }
    }

    /** 仅调整码率，不重建会话、不强制关键帧。 */
    func setBitrate(_ bps: Int) {
        queue.async {
            let clamped = max(300_000, min(60_000_000, bps))
            guard clamped != self.bitrateBps else { return }
            self.bitrateBps = clamped
            self.applyDynamicRates()
        }
    }

    func requestKeyframe() {
        queue.async {
            self.forceNextKeyframe = true
        }
    }

    func encode(pixelBuffer: CVImageBuffer, pts: CMTime, force: Bool = false) {
        queue.async {
            guard let session = self.session else { return }
            let wantsKeyframe = self.forceNextKeyframe || force
            // 硬件编码器积压时丢弃新帧：宁可少一帧也不让画面延迟累积。关键帧请求不丢。
            if self.inFlight >= 2 && !wantsKeyframe {
                self.bump { self.busySkipped += 1 }
                return
            }
            var frameProps: [CFString: Any]? = nil
            if wantsKeyframe {
                frameProps = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue as Any]
                self.forceNextKeyframe = false
            }
            self.inFlight += 1
            var infoFlags = VTEncodeInfoFlags()
            let status = VTCompressionSessionEncodeFrame(
                session,
                imageBuffer: pixelBuffer,
                presentationTimeStamp: pts,
                duration: CMTime(value: 1, timescale: CMTimeScale(max(1, self.fps))),
                frameProperties: frameProps as CFDictionary?,
                infoFlagsOut: &infoFlags
            ) { [weak self] status, flags, sampleBuffer in
                guard let self else { return }
                self.queue.async { self.inFlight = max(0, self.inFlight - 1) }
                guard status == noErr, !flags.contains(.frameDropped), let sampleBuffer, CMSampleBufferDataIsReady(sampleBuffer) else {
                    if status == noErr { self.bump { self.vtDropped += 1 } }
                    return
                }
                self.bump { self.encodedCount += 1 }
                self.handleSampleBuffer(sampleBuffer)
            }
            if status != noErr {
                self.inFlight = max(0, self.inFlight - 1)
                if wantsKeyframe { self.forceNextKeyframe = true }
            }
        }
    }

    func stop() {
        queue.sync {
            self.teardownLocked()
        }
    }

    private func createSessionLocked() {
        let spec: [CFString: Any] = [
            kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: kCFBooleanTrue as Any,
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue as Any,
        ]
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width,
            height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: spec as CFDictionary,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &created
        )
        guard status == noErr, let session = created else { return }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_H264EntropyMode, value: kVTH264EntropyMode_CAVLC)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: 0 as CFNumber)
        // 长 GOP：关键帧由 PLI/FIR、开流与切换按需触发，30 秒兜底一次，避免周期性大 IDR 突发。
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: (fps * 30) as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: 30.0 as CFNumber)
        if #available(macOS 12.0, *) {
            VTSessionSetProperty(session, key: kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, value: kCFBooleanTrue)
        }
        self.session = session
        applyDynamicRates()
        VTCompressionSessionPrepareToEncodeFrames(session)
        forceNextKeyframe = true
        inFlight = 0
    }

    private func applyDynamicRates() {
        guard let session else { return }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrateBps as CFNumber)
        let bytesPerSec = Int(Double(bitrateBps) / 8.0 * 1.15)
        let limits = [bytesPerSec, 1] as CFArray
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: limits)
    }

    private func teardownLocked() {
        if let session {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
            self.session = nil
        }
        inFlight = 0
    }

    private func handleSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        let blockStatus = CMBlockBufferGetDataPointer(
            dataBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength,
            dataPointerOut: &dataPointer
        )
        guard blockStatus == kCMBlockBufferNoErr, let basePtr = dataPointer, totalLength > 0 else { return }

        var isKeyframe = true
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[CFString: Any]],
           let first = attachments.first,
           let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool {
            isKeyframe = !notSync
        }

        var spsData: Data? = nil
        var ppsData: Data? = nil
        if isKeyframe, let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) {
            var spsPtr: UnsafePointer<UInt8>?
            var spsLen = 0
            var count = 0
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                formatDesc,
                parameterSetIndex: 0,
                parameterSetPointerOut: &spsPtr,
                parameterSetSizeOut: &spsLen,
                parameterSetCountOut: &count,
                nalUnitHeaderLengthOut: nil
            ) == noErr, let spsPtr, spsLen > 0 {
                spsData = Data(bytes: spsPtr, count: spsLen)
            }
            var ppsPtr: UnsafePointer<UInt8>?
            var ppsLen = 0
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                formatDesc,
                parameterSetIndex: 1,
                parameterSetPointerOut: &ppsPtr,
                parameterSetSizeOut: &ppsLen,
                parameterSetCountOut: nil,
                nalUnitHeaderLengthOut: nil
            ) == noErr, let ppsPtr, ppsLen > 0 {
                ppsData = Data(bytes: ppsPtr, count: ppsLen)
            }
        }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let ptsSeconds = CMTimeGetSeconds(pts)
        let ptsUs: UInt64 = ptsSeconds.isFinite && ptsSeconds >= 0
            ? UInt64(ptsSeconds * 1_000_000.0)
            : UInt64(DispatchTime.now().uptimeNanoseconds / 1_000)

        let avcc = Data(bytes: basePtr, count: totalLength)
        onEncodedFrame?(isKeyframe, ptsUs, spsData, ppsData, avcc)
    }
}

final class ScreenCapturePipeline: NSObject, SCStreamOutput, SCStreamDelegate {
    private let encoder = HardwareH264Encoder()
    private let sampleQueue = DispatchQueue(label: "app.you-brain.rd.capture", qos: .userInteractive)
    private var stream: SCStream?
    private var currentConfig: SCStreamConfiguration?
    private var activeDisplayId: CGDirectDisplayID = CGMainDisplayID()
    private var maxDimension: Int = 1920
    private var fps: Int = 60
    private var bitrateBps: Int = 8_500_000
    private var showsCursor = true
    private var latestPixelBuffer: CVPixelBuffer?
    private var lastPts: CMTime = .invalid
    private let bufferLock = NSLock()
    /** 诊断计数（累计）：ScreenCaptureKit 交付的完整帧（画面不变时不交付）。 */
    private var capturedCount = 0

    /** 视频管线累计计数，供宿主按时间差换算成每秒帧数。 */
    func counters() -> [String: Int] {
        bufferLock.lock()
        let captured = capturedCount
        bufferLock.unlock()
        let enc = encoder.counters()
        return ["captured": captured, "busy": enc.busy, "dropped": enc.dropped, "encoded": enc.encoded]
    }

    var onEncodedFrame: ((Bool, UInt64, Data?, Data?, Data) -> Void)? {
        didSet { encoder.onEncodedFrame = onEncodedFrame }
    }
    var onError: ((String) -> Void)?

    static func enumerateDisplays() -> [DisplayDescriptor] {
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        guard count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &ids, &count)
        let mainId = CGMainDisplayID()
        let screensById: [CGDirectDisplayID: NSScreen] = Dictionary(
            uniqueKeysWithValues: NSScreen.screens.compactMap { screen in
                guard let num = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
                    return nil
                }
                return (CGDirectDisplayID(num.uint32Value), screen)
            }
        )
        return ids.prefix(Int(count)).enumerated().map { idx, id in
            let bounds = CGDisplayBounds(id)
            let screen = screensById[id]
            let scale = screen?.backingScaleFactor ?? 2.0
            let name: String
            if #available(macOS 10.15, *), let localized = screen?.localizedName, !localized.isEmpty {
                name = localized
            } else {
                name = id == mainId ? "主显示器" : "显示器 \\(idx + 1)"
            }
            return DisplayDescriptor(
                id: id,
                name: name,
                width: max(1, Int(bounds.width.rounded())),
                height: max(1, Int(bounds.height.rounded())),
                scaleFactor: Double(scale),
                primary: id == mainId,
                frame: bounds
            )
        }
    }

    func activeDisplay() -> DisplayDescriptor? {
        let list = Self.enumerateDisplays()
        return list.first(where: { $0.id == activeDisplayId }) ?? list.first
    }

    var isRunning: Bool { stream != nil }

    func setBitrate(_ bps: Int) {
        bitrateBps = bps
        encoder.setBitrate(bps)
    }

    /** 切换光标是否画进画面；已开流时在线更新配置，无需重启采集。 */
    func setShowsCursor(_ value: Bool) {
        guard value != showsCursor else { return }
        showsCursor = value
        guard let stream, let config = currentConfig else { return }
        config.showsCursor = value
        stream.updateConfiguration(config) { [weak self] _ in
            self?.requestKeyframe()
        }
    }

    func startOrUpdate(displayId: CGDirectDisplayID?, maxDimension: Int, fps: Int, bitrateBps: Int, completion: @escaping (CGDirectDisplayID, [DisplayDescriptor]) -> Void) {
        self.maxDimension = maxDimension
        self.fps = fps
        self.bitrateBps = bitrateBps

        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { [weak self] content, error in
            guard let self else { return }
            let descriptors = Self.enumerateDisplays()
            guard let content, error == nil, !content.displays.isEmpty else {
                let fallbackId = displayId ?? descriptors.first?.id ?? CGMainDisplayID()
                self.activeDisplayId = fallbackId
                completion(fallbackId, descriptors)
                if let error {
                    self.onError?(error.localizedDescription)
                }
                return
            }

            let chosenSCDisplay: SCDisplay
            if let requested = displayId, let matched = content.displays.first(where: { $0.displayID == requested }) {
                chosenSCDisplay = matched
            } else if let current = content.displays.first(where: { $0.displayID == self.activeDisplayId }), self.stream != nil {
                chosenSCDisplay = current
            } else if let primary = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) {
                chosenSCDisplay = primary
            } else {
                chosenSCDisplay = content.displays[0]
            }

            self.activeDisplayId = chosenSCDisplay.displayID
            let desc = descriptors.first(where: { $0.id == chosenSCDisplay.displayID })
            let scale = desc?.scaleFactor ?? 2.0
            let nativeW = Double(chosenSCDisplay.width) * scale
            let nativeH = Double(chosenSCDisplay.height) * scale
            let longest = max(nativeW, nativeH, 1.0)
            let ratio = min(1.0, Double(maxDimension) / longest)
            let targetW = max(128, Int((nativeW * ratio).rounded()) & ~1)
            let targetH = max(128, Int((nativeH * ratio).rounded()) & ~1)

            self.encoder.configure(width: Int32(targetW), height: Int32(targetH), fps: fps, bitrateBps: bitrateBps)

            let config = SCStreamConfiguration()
            config.width = targetW
            config.height = targetH
            config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, fps)))
            config.queueDepth = 3
            config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            config.colorSpaceName = CGColorSpace.sRGB
            config.showsCursor = self.showsCursor
            if #available(macOS 13.0, *) {
                config.capturesAudio = false
            }
            self.currentConfig = config

            let filter = SCContentFilter(display: chosenSCDisplay, excludingWindows: [])
            if let existing = self.stream {
                existing.updateContentFilter(filter) { _ in }
                existing.updateConfiguration(config) { _ in
                    self.requestKeyframe()
                }
                completion(chosenSCDisplay.displayID, descriptors)
                return
            }

            let newStream = SCStream(filter: filter, configuration: config, delegate: self)
            do {
                try newStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.sampleQueue)
                self.stream = newStream
                newStream.startCapture { captureErr in
                    if let captureErr {
                        self.onError?(captureErr.localizedDescription)
                    }
                }
            } catch {
                self.onError?(error.localizedDescription)
            }
            completion(chosenSCDisplay.displayID, descriptors)
        }
    }

    /** 立即输出关键帧：静止画面也能用缓存的最后一帧即时重编，不必等下一次屏幕变化。 */
    func requestKeyframe() {
        bufferLock.lock()
        let cached = latestPixelBuffer
        let prev = lastPts
        bufferLock.unlock()
        if let cached {
            var nowPts = CMClockGetTime(CMClockGetHostTimeClock())
            if prev.isValid && CMTimeCompare(nowPts, prev) <= 0 {
                nowPts = CMTimeAdd(prev, CMTime(value: 1, timescale: 1_000_000))
            }
            bufferLock.lock()
            lastPts = nowPts
            bufferLock.unlock()
            encoder.encode(pixelBuffer: cached, pts: nowPts, force: true)
        } else {
            encoder.requestKeyframe()
        }
    }

    func stop() {
        if let current = stream {
            stream = nil
            current.stopCapture { _ in }
        }
        currentConfig = nil
        bufferLock.lock()
        latestPixelBuffer = nil
        lastPts = .invalid
        bufferLock.unlock()
        encoder.stop()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let statusRaw = attachments.first?[.status] as? Int,
           let frameStatus = SCFrameStatus(rawValue: statusRaw),
           frameStatus != .complete {
            return
        }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        var pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        bufferLock.lock()
        if lastPts.isValid && CMTimeCompare(pts, lastPts) <= 0 {
            pts = CMTimeAdd(lastPts, CMTime(value: 1, timescale: 1_000_000))
        }
        latestPixelBuffer = pixelBuffer
        lastPts = pts
        capturedCount += 1
        bufferLock.unlock()
        encoder.encode(pixelBuffer: pixelBuffer, pts: pts)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onError?(error.localizedDescription)
    }
}
`;
