/**
 * macOS ScreenCaptureKit + VideoToolbox 60fps 零 B 帧硬件编码管线 Swift 源码片段。
 * 保持独立媒体模块，供 `U-Brain Remote Host.app` 编译时组合。
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
    private let queue = DispatchQueue(label: "app.you-brain.rd.encoder", qos: .userInteractive)
    var onEncodedFrame: ((Bool, UInt64, Data?, Data?, Data) -> Void)?

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

    func requestKeyframe() {
        queue.async {
            self.forceNextKeyframe = true
        }
    }

    func encode(pixelBuffer: CVImageBuffer, pts: CMTime) {
        queue.async {
            guard let session = self.session else { return }
            var frameProps: [CFString: Any]? = nil
            if self.forceNextKeyframe {
                frameProps = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue as Any]
                self.forceNextKeyframe = false
            }
            var infoFlags = VTEncodeInfoFlags()
            VTCompressionSessionEncodeFrame(
                session,
                imageBuffer: pixelBuffer,
                presentationTimeStamp: pts,
                duration: CMTime(value: 1, timescale: CMTimeScale(max(1, self.fps))),
                frameProperties: frameProps as CFDictionary?,
                infoFlagsOut: &infoFlags
            ) { [weak self] status, _, sampleBuffer in
                guard status == noErr, let sampleBuffer, CMSampleBufferDataIsReady(sampleBuffer) else { return }
                self?.handleSampleBuffer(sampleBuffer)
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
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: (fps * 2) as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: 2.0 as CFNumber)
        self.session = session
        applyDynamicRates()
        VTCompressionSessionPrepareToEncodeFrames(session)
        forceNextKeyframe = true
    }

    private func applyDynamicRates() {
        guard let session else { return }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrateBps as CFNumber)
        let bytesPerSec = Int(Double(bitrateBps) / 8.0 * 1.35)
        let limits = [bytesPerSec, 1] as CFArray
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: limits)
    }

    private func teardownLocked() {
        if let session {
            VTCompressionSessionInvalidate(session)
            self.session = nil
        }
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
    private var activeDisplayId: CGDirectDisplayID = CGMainDisplayID()
    private var maxDimension: Int = 1920
    private var fps: Int = 60
    private var bitrateBps: Int = 8_500_000
    private var latestPixelBuffer: CVPixelBuffer?
    private let bufferLock = NSLock()

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
            config.showsCursor = true
            if #available(macOS 13.0, *) {
                config.capturesAudio = false
            }

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

    func requestKeyframe() {
        encoder.requestKeyframe()
        bufferLock.lock()
        let cached = latestPixelBuffer
        bufferLock.unlock()
        if let cached {
            let nowPts = CMTime(
                value: Int64(DispatchTime.now().uptimeNanoseconds / 1_000),
                timescale: 1_000_000
            )
            encoder.encode(pixelBuffer: cached, pts: nowPts)
        }
    }

    func stop() {
        if let current = stream {
            stream = nil
            current.stopCapture { _ in }
        }
        bufferLock.lock()
        latestPixelBuffer = nil
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
        bufferLock.lock()
        latestPixelBuffer = pixelBuffer
        bufferLock.unlock()
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        encoder.encode(pixelBuffer: pixelBuffer, pts: pts)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onError?(error.localizedDescription)
    }
}
`;
