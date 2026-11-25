import { describe, expect, test } from "bun:test";
import { RTCPeerConnection, RTCRtpCodecParameters, type RtpPacket } from "werift";

import {
  BinaryVideoFrameDecoder,
  extractAvccNalus,
  inspectLocalIceInterfaces,
  isBlockedIceCandidateLine,
  LossBasedBitrateController,
  LowLatencyH264RtpStreamer,
  packetizeH264AccessUnit,
  RemoteDesktopHostManager,
  resolveDirectStunIceServers,
  resolveMacKeyCode,
  resolveMdnsIceCandidate,
  stripBlockedIceCandidatesFromSdp,
  type ControlClientMessage,
  type ControlServerMessage,
  type EncodedVideoFrame,
  type FastInputMessage,
  type HostStateSnapshot,
  type RemoteDesktopHostBridge,
} from "../../src/deck/remote-desktop/index.js";

function makeAvcc(nalus: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  for (const nalu of nalus) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(nalu.length, 0);
    parts.push(len, nalu);
  }
  return Buffer.concat(parts);
}

function makeWireVideoChunk(frame: EncodedVideoFrame): Buffer {
  const sps = frame.sps ?? Buffer.alloc(0);
  const pps = frame.pps ?? Buffer.alloc(0);
  const header = Buffer.alloc(24);
  header.writeUInt32BE(0x55425244, 0); // "UBRD"
  header.writeUInt32BE(frame.keyframe ? 1 : 0, 4);
  header.writeBigUInt64BE(BigInt(frame.ptsUs), 8);
  header.writeUInt16BE(sps.length, 16);
  header.writeUInt16BE(pps.length, 18);
  header.writeUInt32BE(frame.avcc.length, 20);
  return Buffer.concat([header, sps, pps, frame.avcc]);
}

describe("RTP H.264 packetizer & low-latency streamer", () => {
  test("extractAvccNalus skips AUD(9) and extracts slice NALUs", () => {
    const aud = Buffer.from([0x09, 0xf0]);
    const idr = Buffer.from([0x65, 0x88, 0x84, 0x21]);
    const slice = Buffer.from([0x41, 0x9a, 0x01]);
    const nalus = extractAvccNalus(makeAvcc([aud, idr, slice]));
    expect(nalus).toHaveLength(2);
    expect(nalus[0]?.equals(idr)).toBe(true);
    expect(nalus[1]?.equals(slice)).toBe(true);
  });

  test("packetizeH264AccessUnit packs SPS/PPS into STAP-A and fragments large IDR into FU-A", () => {
    const sps = Buffer.from([0x67, 0x42, 0xe0, 0x1f, 0xda, 0x01]);
    const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
    const bigIdr = Buffer.alloc(2600, 0xab);
    bigIdr[0] = 0x65; // NRI=3, Type=5 (IDR)

    const packets = packetizeH264AccessUnit(
      {
        keyframe: true,
        ptsUs: 1_000_000,
        sps,
        pps,
        avcc: makeAvcc([sps, pps, bigIdr]),
      },
      1000,
    );

    // 1 STAP-A + 3 FU-A fragments (2599 bytes / 998 bytes per fragment = 3)
    expect(packets).toHaveLength(4);
    expect(packets[0]![0]! & 0x1f).toBe(24); // STAP-A
    expect(packets[1]![0]! & 0x1f).toBe(28); // FU-A
    expect(packets[1]![1]! & 0xc0).toBe(0x80); // Start bit
    expect(packets[2]![1]! & 0xc0).toBe(0x00); // Middle fragment
    expect(packets[3]![1]! & 0xc0).toBe(0x40); // End bit

    // Reassemble FU-A back into original IDR NALU
    const reassembled = Buffer.concat([
      Buffer.from([(packets[1]![0]! & 0xe0) | (packets[1]![1]! & 0x1f)]),
      packets[1]!.subarray(2),
      packets[2]!.subarray(2),
      packets[3]!.subarray(2),
    ]);
    expect(reassembled.equals(bigIdr)).toBe(true);
  });

  test("LowLatencyH264RtpStreamer sets marker on final packet and drops stale queue on overload", async () => {
    const sent: RtpPacket[] = [];
    let unblockFirst!: () => void;
    let blockFirst = true;
    const firstGate = new Promise<void>((res) => {
      unblockFirst = res;
    });

    let keyframeRequested = 0;
    const streamer = new LowLatencyH264RtpStreamer(
      {
        ssrc: 0x12345678,
        payloadType: 96,
        async sendRtp(pkt) {
          if (blockFirst) {
            blockFirst = false;
            await firstGate;
          }
          sent.push(pkt);
        },
      },
      {
        onDropNeedKeyframe: () => {
          keyframeRequested += 1;
        },
        sleep: async () => {},
      },
    );

    const pFrame = (ptsUs: number): EncodedVideoFrame => ({
      keyframe: false,
      ptsUs,
      sps: null,
      pps: null,
      avcc: makeAvcc([Buffer.from([0x41, 0x01, 0x02, 0x03])]),
    });

    streamer.enqueue(pFrame(0));
    // Queue 4 more while first is still in flight -> exceeds MAX_QUEUED_FRAMES(3)
    streamer.enqueue(pFrame(16_667));
    streamer.enqueue(pFrame(33_333));
    streamer.enqueue(pFrame(50_000));
    streamer.enqueue(pFrame(66_667));

    expect(keyframeRequested).toBe(1);
    unblockFirst();
    await new Promise((res) => setTimeout(res, 20));
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0]?.header.marker).toBe(true);
    streamer.close();
  });
});

describe("BinaryVideoFrameDecoder & macOS keycodes", () => {
  test("reassembles frames split across arbitrary byte chunks", () => {
    const decoder = new BinaryVideoFrameDecoder();
    const sps = Buffer.from([0x67, 0x42, 0x00, 0x1f]);
    const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
    const avcc = makeAvcc([Buffer.from([0x65, 0x11, 0x22, 0x33])]);
    const wire1 = makeWireVideoChunk({ keyframe: true, ptsUs: 123_456, sps, pps, avcc });
    const wire2 = makeWireVideoChunk({
      keyframe: false,
      ptsUs: 140_123,
      sps: null,
      pps: null,
      avcc: makeAvcc([Buffer.from([0x41, 0x99])]),
    });
    const combined = Buffer.concat([wire1, wire2]);

    const decoded: EncodedVideoFrame[] = [];
    for (let i = 0; i < combined.length; i += 7) {
      decoder.push(combined.subarray(i, Math.min(combined.length, i + 7)), (f) => decoded.push(f));
    }

    expect(decoded).toHaveLength(2);
    expect(decoded[0]?.keyframe).toBe(true);
    expect(decoded[0]?.ptsUs).toBe(123_456);
    expect(decoded[0]?.sps?.equals(sps)).toBe(true);
    expect(decoded[1]?.keyframe).toBe(false);
    expect(decoded[1]?.ptsUs).toBe(140_123);
  });

  test("maps common W3C KeyboardEvent.code values to Quartz CGKeyCode", () => {
    expect(resolveMacKeyCode("KeyA")).toBe(0x00);
    expect(resolveMacKeyCode("Enter")).toBe(0x24);
    expect(resolveMacKeyCode("Escape")).toBe(0x35);
    expect(resolveMacKeyCode("MetaLeft")).toBe(0x37);
    expect(resolveMacKeyCode("ArrowUp")).toBe(0x7e);
    expect(resolveMacKeyCode("UnknownCode")).toBeNull();
  });
});

describe("RemoteDesktopHostManager WebRTC end-to-end loopback", () => {
  test("establishes 60fps H.264 + dual DataChannels (input-fast & control) over localhost ICE", async () => {
    const fastInputs: FastInputMessage[] = [];
    const controlInputs: ControlClientMessage[] = [];
    let keyframeRequests = 0;
    const videoListeners = new Set<(frame: EncodedVideoFrame) => void>();
    const clipboardListeners = new Set<(text: string) => void>();
    let snapshot: HostStateSnapshot = {
      displays: [
        { id: 1, name: "Built-in Retina Display", width: 1920, height: 1080, scaleFactor: 2, primary: true },
        { id: 2, name: "Studio Display", width: 2560, height: 1440, scaleFactor: 2, primary: false },
      ],
      activeDisplayId: 1,
      permissions: { screenRecording: true, accessibility: true },
    };

    const mockBridge: RemoteDesktopHostBridge = {
      async ensureStarted(opts) {
        if (opts.displayId !== undefined) snapshot = { ...snapshot, activeDisplayId: opts.displayId };
        return snapshot;
      },
      async configure(opts) {
        if (opts.displayId !== undefined) snapshot = { ...snapshot, activeDisplayId: opts.displayId };
        return snapshot;
      },
      getStateSnapshot() {
        return snapshot;
      },
      requestKeyframe() {
        keyframeRequests += 1;
      },
      requestPermissionsPrompt() {},
      handleFastInput(msg) {
        fastInputs.push(msg);
      },
      handleControlInput(msg) {
        controlInputs.push(msg);
        if (msg.t === "cb.get") {
          for (const cb of clipboardListeners) cb("hello-from-mac");
        }
      },
      releaseInputs() {},
      subscribeVideo(fn) {
        videoListeners.add(fn);
        return () => videoListeners.delete(fn);
      },
      subscribeState() {
        return () => {};
      },
      subscribeClipboard(fn) {
        clipboardListeners.add(fn);
        return () => clipboardListeners.delete(fn);
      },
      subscribeError() {
        return () => {};
      },
      async close() {},
    };

    const manager = new RemoteDesktopHostManager({
      supported: true,
      bridge: mockBridge,
      getIceServers: () => [],
      helperIdleGraceMs: 50,
    });

    const clientPc = new RTCPeerConnection({
      codecs: {
        video: [
          new RTCRtpCodecParameters({
            mimeType: "video/H264",
            clockRate: 90_000,
            parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
          }),
        ],
      },
    });

    const receivedRtp: RtpPacket[] = [];
    const transceiver = clientPc.addTransceiver("video", { direction: "recvonly" });
    transceiver.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((rtp) => {
        receivedRtp.push(rtp);
      });
    });

    const fastDc = clientPc.createDataChannel("input-fast", { ordered: false, maxRetransmits: 0 });
    const controlDc = clientPc.createDataChannel("control", { ordered: true });
    const serverMessages: ControlServerMessage[] = [];
    controlDc.onMessage.subscribe((raw) => {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      serverMessages.push(JSON.parse(text) as ControlServerMessage);
    });

    let activeSessionId = "";
    const pendingClientIce: Array<{ candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }> = [];

    manager.setSignalingEvents({
      onIce(_to, sid, candidates) {
        if (sid !== activeSessionId) return;
        for (const c of candidates) {
          if (c.candidate) {
            void clientPc.addIceCandidate({
              candidate: c.candidate,
              sdpMid: c.sdpMid ?? null,
              sdpMLineIndex: c.sdpMLineIndex ?? null,
            });
          }
        }
      },
      onState() {},
    });

    clientPc.onIceCandidate.subscribe((cand) => {
      if (!cand?.candidate) return;
      const item = {
        candidate: cand.candidate,
        sdpMid: cand.sdpMid ?? null,
        sdpMLineIndex: cand.sdpMLineIndex ?? null,
      };
      if (activeSessionId) {
        void manager.addIceCandidates("peer-web", { sessionId: activeSessionId, candidates: [item] });
      } else {
        pendingClientIce.push(item);
      }
    });

    const offer = await clientPc.createOffer();
    await clientPc.setLocalDescription(offer);

    const openRes = await manager.openSession("peer-web", {
      sessionId: "rd_loopback_test_01",
      offerSdp: offer.sdp,
      quality: "hd",
    });
    activeSessionId = openRes.sessionId;
    expect(openRes.displays).toHaveLength(2);
    expect(openRes.answerSdp).toContain("H264");

    await clientPc.setRemoteDescription({ type: "answer", sdp: openRes.answerSdp });
    if (pendingClientIce.length > 0) {
      await manager.addIceCandidates("peer-web", {
        sessionId: activeSessionId,
        candidates: pendingClientIce,
      });
    }

    // Wait for both DataChannels to open
    await Promise.all([
      fastDc.readyState === "open"
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            fastDc.stateChanged.subscribe((st) => {
              if (st === "open") resolve();
            });
          }),
      controlDc.readyState === "open"
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            controlDc.stateChanged.subscribe((st) => {
              if (st === "open") resolve();
            });
          }),
    ]);

    // Stream a keyframe from the host bridge and verify RTP delivery
    for (const listener of videoListeners) {
      listener({
        keyframe: true,
        ptsUs: 100_000,
        sps: Buffer.from([0x67, 0x42, 0xe0, 0x1f]),
        pps: Buffer.from([0x68, 0xce, 0x3c, 0x80]),
        avcc: makeAvcc([Buffer.from([0x65, 0x88, 0x84, 0x21])]),
      });
    }

    // Send fast input + control messages
    fastDc.send(JSON.stringify({ t: "mm", x: 0.25, y: 0.75 }));
    controlDc.send(JSON.stringify({ t: "md", x: 0.25, y: 0.75, b: 0, clicks: 1 }));
    controlDc.send(JSON.stringify({ t: "disp", displayId: 2 }));
    controlDc.send(JSON.stringify({ t: "cb.get" }));
    controlDc.send(JSON.stringify({ t: "ping", ts: 4242 }));

    const deadline = Date.now() + 2000;
    while (
      Date.now() < deadline &&
      (receivedRtp.length < 2 ||
        fastInputs.length < 1 ||
        !serverMessages.some((m) => m.t === "pong" && m.ts === 4242) ||
        !serverMessages.some((m) => m.t === "cb" && m.text === "hello-from-mac") ||
        !serverMessages.some((m) => m.t === "state" && m.activeDisplayId === 2))
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(receivedRtp.length).toBeGreaterThanOrEqual(2);
    expect(fastInputs[0]).toEqual({ t: "mm", x: 0.25, y: 0.75 });
    expect(controlInputs.some((m) => m.t === "md" && m.b === 0)).toBe(true);
    expect(serverMessages.some((m) => m.t === "pong" && m.ts === 4242)).toBe(true);
    expect(serverMessages.some((m) => m.t === "cb" && m.text === "hello-from-mac")).toBe(true);
    expect(serverMessages.some((m) => m.t === "state" && m.activeDisplayId === 2)).toBe(true);
    expect(keyframeRequests).toBeGreaterThanOrEqual(1);

    await manager.closeSession("peer-web", { sessionId: activeSessionId });
    await clientPc.close();
    await manager.closeAll();
  });

  test("openSession omits sessionId falls back to valid rd- id, and warmup invokes bridge.warmup safely", async () => {
    let warmupCalls = 0;
    const mockBridge: RemoteDesktopHostBridge = {
      async warmup() {
        warmupCalls += 1;
      },
      async ensureStarted() {
        return {
          displays: [{ id: 1, name: "Main", width: 1280, height: 800, scaleFactor: 2, primary: true }],
          activeDisplayId: 1,
          permissions: { screenRecording: true, accessibility: true },
        };
      },
      async configure() {
        return {
          displays: [{ id: 1, name: "Main", width: 1280, height: 800, scaleFactor: 2, primary: true }],
          activeDisplayId: 1,
          permissions: { screenRecording: true, accessibility: true },
        };
      },
      getStateSnapshot() {
        return {
          displays: [{ id: 1, name: "Main", width: 1280, height: 800, scaleFactor: 2, primary: true }],
          activeDisplayId: 1,
          permissions: { screenRecording: true, accessibility: true },
        };
      },
      requestKeyframe() {},
      requestPermissionsPrompt() {},
      handleFastInput() {},
      handleControlInput() {},
      releaseInputs() {},
      subscribeVideo() {
        return () => {};
      },
      subscribeState() {
        return () => {};
      },
      subscribeClipboard() {
        return () => {};
      },
      subscribeError() {
        return () => {};
      },
      async close() {},
    };

    const manager = new RemoteDesktopHostManager({
      supported: true,
      bridge: mockBridge,
      getIceServers: () => [],
      helperIdleGraceMs: 0,
    });
    manager.warmup();
    expect(warmupCalls).toBe(1);

    const unsupportedManager = new RemoteDesktopHostManager({
      supported: false,
      bridge: mockBridge,
      getIceServers: () => [],
    });
    unsupportedManager.warmup();
    expect(warmupCalls).toBe(1);

    const clientPc = new RTCPeerConnection({
      codecs: {
        video: [
          new RTCRtpCodecParameters({
            mimeType: "video/H264",
            clockRate: 90_000,
            parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
          }),
        ],
      },
    });
    clientPc.addTransceiver("video", { direction: "recvonly" });
    clientPc.createDataChannel("control", { ordered: true });
    const offer = await clientPc.createOffer();
    await clientPc.setLocalDescription(offer);

    const opened = await manager.openSession("peer-android-old", {
      offerSdp: offer.sdp,
      quality: "smooth",
    });
    expect(opened.sessionId).toMatch(/^rd-[A-Za-z0-9_-]{8,64}$/);
    await manager.closeSession("peer-android-old", { sessionId: opened.sessionId });
    await clientPc.close();
    await manager.closeAll();
  });

  test("mDNS .local ICE 候选解析、TURN 起步码率约束、孤立 P 帧过滤与鼠标乱序去重", async () => {
    // 1. mDNS .local -> IPv4 解析与同域名去重缓存
    let lookups = 0;
    const cache = new Map<string, Promise<string | null>>();
    const lookupFn = async (host: string) => {
      lookups += 1;
      return host.startsWith("good-") ? "192.168.31.88" : null;
    };
    const cand1 = await resolveMdnsIceCandidate(
      "candidate:1 1 UDP 2122260223 good-uuid.local 54321 typ host",
      cache,
      lookupFn,
    );
    const cand2 = await resolveMdnsIceCandidate(
      "a=candidate:2 1 UDP 2122260223 GOOD-UUID.local 54322 typ host",
      cache,
      lookupFn,
    );
    const candUnresolved = await resolveMdnsIceCandidate(
      "candidate:3 1 UDP 2122260223 missing.local 54323 typ host",
      cache,
      lookupFn,
    );
    const candPublic = await resolveMdnsIceCandidate(
      "candidate:4 1 UDP 1686052607 203.0.113.9 54324 typ srflx",
      cache,
      lookupFn,
    );
    expect(cand1).toBe("candidate:1 1 UDP 2122260223 192.168.31.88 54321 typ host");
    expect(cand2).toBe("a=candidate:2 1 UDP 2122260223 192.168.31.88 54322 typ host");
    expect(candUnresolved).toBeNull();
    expect(candPublic).toBe("candidate:4 1 UDP 1686052607 203.0.113.9 54324 typ srflx");
    expect(lookups).toBe(2);

    // 2. TURN 中继模式压低初始峰值码率并在零丢包反馈下平滑爬升
    const appliedBitrates: number[] = [];
    const bc = new LossBasedBitrateController({
      maxBps: 8_500_000,
      onChange: (bps) => appliedBitrates.push(bps),
    });
    bc.setRelayMode(true);
    expect(bc.targetBps).toBe(Math.round(8_500_000 * 0.42));
    expect(appliedBitrates[0]).toBe(Math.round(8_500_000 * 0.42));
    bc.onReceiverReport(0, 1000);
    expect(bc.targetBps).toBeGreaterThan(Math.round(8_500_000 * 0.42));

    // 3. 队列过载丢帧后，孤立 P 帧在下一关键帧到来前一律跳过且不重复请求 IDR
    const rtpSent: RtpPacket[] = [];
    let gateOpen!: () => void;
    let holdFirst = true;
    const gate = new Promise<void>((res) => {
      gateOpen = res;
    });
    let idrCount = 0;
    const streamer = new LowLatencyH264RtpStreamer(
      {
        ssrc: 0x11112222,
        payloadType: 96,
        async sendRtp(pkt) {
          if (holdFirst) {
            holdFirst = false;
            await gate;
          }
          rtpSent.push(pkt);
        },
      },
      {
        onDropNeedKeyframe: () => {
          idrCount += 1;
        },
        sleep: async () => {},
      },
    );
    const makeP = (ptsUs: number): EncodedVideoFrame => ({
      keyframe: false,
      ptsUs,
      sps: null,
      pps: null,
      avcc: makeAvcc([Buffer.from([0x41, 0x10, 0x20])]),
    });
    const makeIdr = (ptsUs: number): EncodedVideoFrame => ({
      keyframe: true,
      ptsUs,
      sps: Buffer.from([0x67, 0x42, 0xe0, 0x1f]),
      pps: Buffer.from([0x68, 0xce, 0x3c, 0x80]),
      avcc: makeAvcc([Buffer.from([0x65, 0x88, 0x84])]),
    });
    streamer.enqueue(makeP(0)); // 正在发送
    streamer.enqueue(makeP(16_667));
    streamer.enqueue(makeP(33_333));
    streamer.enqueue(makeP(50_000));
    streamer.enqueue(makeP(66_667)); // 触发过载丢帧并进入 awaitingKeyframe
    streamer.enqueue(makeP(83_333)); // 孤立 P 帧，应被直接忽略且不再次请求 IDR
    expect(idrCount).toBe(1);
    streamer.enqueue(makeIdr(100_000)); // 新 IDR 恢复参考链
    gateOpen();
    await new Promise((r) => setTimeout(r, 20));
    // 只发送了第 1 个在途 P 帧(1 包) + 新 IDR(STAP-A + IDR = 2 包)，中间孤立 P 帧全部被干净丢弃
    expect(rtpSent).toHaveLength(3);
    streamer.close();

    // 4. 鼠标序号去重：乱序旧 mm 与滞后于 md 的旧 mm 均被丢弃
    const fastReceived: FastInputMessage[] = [];
    const mockBridge: RemoteDesktopHostBridge = {
      async ensureStarted() {
        return {
          displays: [{ id: 1, name: "Main", width: 1440, height: 900, scaleFactor: 2, primary: true }],
          activeDisplayId: 1,
          permissions: { screenRecording: true, accessibility: true },
        };
      },
      async configure() {
        return this.getStateSnapshot();
      },
      getStateSnapshot() {
        return {
          displays: [{ id: 1, name: "Main", width: 1440, height: 900, scaleFactor: 2, primary: true }],
          activeDisplayId: 1,
          permissions: { screenRecording: true, accessibility: true },
        };
      },
      requestKeyframe() {},
      requestPermissionsPrompt() {},
      handleFastInput(msg) {
        fastReceived.push(msg);
      },
      handleControlInput() {},
      releaseInputs() {},
      subscribeVideo: () => () => {},
      subscribeState: () => () => {},
      subscribeClipboard: () => () => {},
      subscribeError: () => () => {},
      async close() {},
    };

    const manager = new RemoteDesktopHostManager({
      supported: true,
      bridge: mockBridge,
      getIceServers: () => [],
      helperIdleGraceMs: 0,
    });
    const clientPc = new RTCPeerConnection({
      codecs: {
        video: [
          new RTCRtpCodecParameters({
            mimeType: "video/H264",
            clockRate: 90_000,
            parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
          }),
        ],
      },
    });
    clientPc.addTransceiver("video", { direction: "recvonly" });
    const fastDc = clientPc.createDataChannel("input-fast", { ordered: false, maxRetransmits: 0 });
    const controlDc = clientPc.createDataChannel("control", { ordered: true });
    let sid = "";
    const pendingIce: Array<{ candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }> = [];
    manager.setSignalingEvents({
      onIce(_to, sessionId, candidates) {
        if (sessionId !== sid) return;
        for (const c of candidates) {
          if (c.candidate) void clientPc.addIceCandidate({ candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null });
        }
      },
      onState() {},
    });
    clientPc.onIceCandidate.subscribe((cand) => {
      if (!cand?.candidate) return;
      const item = { candidate: cand.candidate, sdpMid: cand.sdpMid ?? null, sdpMLineIndex: cand.sdpMLineIndex ?? null };
      if (sid) void manager.addIceCandidates("peer-seq", { sessionId: sid, candidates: [item] });
      else pendingIce.push(item);
    });
    const offer = await clientPc.createOffer();
    await clientPc.setLocalDescription(offer);
    const opened = await manager.openSession("peer-seq", { offerSdp: offer.sdp, quality: "smooth" });
    sid = opened.sessionId;
    await clientPc.setRemoteDescription({ type: "answer", sdp: opened.answerSdp });
    if (pendingIce.length > 0) await manager.addIceCandidates("peer-seq", { sessionId: sid, candidates: pendingIce });

    await Promise.all([
      fastDc.readyState === "open"
        ? Promise.resolve()
        : new Promise<void>((r) => fastDc.stateChanged.subscribe((s) => s === "open" && r())),
      controlDc.readyState === "open"
        ? Promise.resolve()
        : new Promise<void>((r) => controlDc.stateChanged.subscribe((s) => s === "open" && r())),
    ]);

    fastDc.send(JSON.stringify({ t: "mm", x: 0.5, y: 0.5, seq: 10 }));
    await new Promise((r) => setTimeout(r, 25));
    // 乱序迟到的 seq=9 应被丢弃
    fastDc.send(JSON.stringify({ t: "mm", x: 0.1, y: 0.1, seq: 9 }));
    // 可靠通道 md 携带 seq=15 推进水位线，随后迟到的 seq=12 mm 也应被丢弃
    controlDc.send(JSON.stringify({ t: "md", x: 0.6, y: 0.6, b: 0, clicks: 1, seq: 15 }));
    await new Promise((r) => setTimeout(r, 25));
    fastDc.send(JSON.stringify({ t: "mm", x: 0.2, y: 0.2, seq: 12 }));
    fastDc.send(JSON.stringify({ t: "mm", x: 0.7, y: 0.7, seq: 16 }));
    await new Promise((r) => setTimeout(r, 40));

    expect(fastReceived.map((m) => (m.t === "mm" ? m.seq : -1))).toEqual([10, 16]);

    await manager.closeSession("peer-seq", { sessionId: sid });
    await clientPc.close();
    await manager.closeAll();
  });

  test("代理 Fake-IP/TUN 网卡过滤、Tailscale/LAN 优选排序、国内直连 STUN 反劫持与 TURN->P2P 码率恢复", async () => {
    const inspected = inspectLocalIceInterfaces({
      lo0: [
        { address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" },
      ],
      en0: [
        { address: "fe80::1%en0", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "aa:bb:cc:dd:ee:01", internal: false, cidr: "fe80::1/64", scopeid: 4 },
        { address: "172.16.202.20", netmask: "255.255.252.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:01", internal: false, cidr: "172.16.202.20/22" },
        { address: "2409:8a00:1234::88", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "aa:bb:cc:dd:ee:01", internal: false, cidr: "2409:8a00:1234::88/64", scopeid: 0 },
      ],
      awdl0: [
        { address: "fe80::99%awdl0", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "aa:bb:cc:dd:ee:02", internal: false, cidr: "fe80::99/64", scopeid: 8 },
      ],
      utun3: [
        { address: "100.101.102.103", netmask: "255.192.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "100.101.102.103/10" },
        { address: "fd7a:115c:a1e0::103", netmask: "ffff:ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: false, cidr: "fd7a:115c:a1e0::103/48", scopeid: 0 },
      ],
      utun5: [
        { address: "198.18.0.1", netmask: "255.254.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "198.18.0.1/15" },
        { address: "fd11:dead:beef::10", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: false, cidr: "fd11:dead:beef::10/64", scopeid: 0 },
      ],
    });

    // Tailscale IPv4 排第一，其次物理局域网 IPv4，再其次 Tailscale/公网 IPv6；utun5 伴生 IPv6 一并拉黑
    expect(inspected.preferredHostAddresses).toEqual([
      "100.101.102.103",
      "172.16.202.20",
      "fd7a:115c:a1e0::103",
      "2409:8a00:1234::88",
    ]);
    expect(inspected.blockedIps.has("198.18.0.1")).toBe(true);
    expect(inspected.blockedIps.has("fd11:dead:beef::10")).toBe(true);

    // 候选行过滤：Fake-IP host、伴生 TUN IPv6、以及绑定在 Fake-IP 底座上的代理 srflx 一律拦截
    expect(
      isBlockedIceCandidateLine("candidate:1 1 UDP 2122260223 198.18.0.1 51000 typ host", inspected.blockedIps),
    ).toBe(true);
    expect(
      isBlockedIceCandidateLine("candidate:2 1 UDP 2122194687 fd11:dead:beef::10 51001 typ host", inspected.blockedIps),
    ).toBe(true);
    expect(
      isBlockedIceCandidateLine(
        "candidate:3 1 UDP 1686052607 216.167.74.66 40123 typ srflx raddr 198.18.0.1 rport 51000",
        inspected.blockedIps,
      ),
    ).toBe(true);
    expect(
      isBlockedIceCandidateLine("candidate:4 1 UDP 2122260223 100.101.102.103 51002 typ host", inspected.blockedIps),
    ).toBe(false);
    expect(
      isBlockedIceCandidateLine(
        "candidate:5 1 UDP 1686052607 61.174.30.194 40124 typ srflx raddr 172.16.202.20 rport 51003",
        inspected.blockedIps,
      ),
    ).toBe(false);

    const rawSdp = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=candidate:1 1 UDP 2122260223 198.18.0.1 51000 typ host",
      "a=candidate:2 1 UDP 2122260223 172.16.202.20 51003 typ host",
      "",
    ].join("\r\n");
    expect(stripBlockedIceCandidatesFromSdp(rawSdp, inspected.blockedIps)).toBe(
      [
        "v=0",
        "m=video 9 UDP/TLS/RTP/SAVPF 96",
        "a=candidate:2 1 UDP 2122260223 172.16.202.20 51003 typ host",
        "",
      ].join("\r\n"),
    );

    // Fake-IP 环境下：剔除停服 stun.qq.com 与海外代理 STUN，并将国内 STUN 解析为真实国内公网 IPv4
    const resolvedFakeIp = await resolveDirectStunIceServers(
      [
        {
          urls: [
            "stun:stun.cloudflare.com:3478",
            "stun:stun.miwifi.com:3478",
            "stun:stun.qq.com:3478",
            "stun:stun.l.google.com:19302",
          ],
        },
        {
          urls: ["turn:203.0.113.50:3478?transport=udp"],
          username: "u",
          credential: "p",
        },
      ],
      {
        useCache: false,
        systemLookup: async () => "198.18.0.248",
        directResolve4: async (host) => {
          if (host === "stun.chat.bilibili.com") return ["106.12.251.52"];
          if (host === "stun.miwifi.com") return ["111.206.174.2"];
          return [];
        },
      },
    );
    expect(resolvedFakeIp).toEqual([
      {
        urls: ["stun:106.12.251.52:3478", "stun:111.206.174.2:3478"],
      },
      {
        urls: ["turn:203.0.113.50:3478?transport=udp"],
        username: "u",
        credential: "p",
      },
    ]);

    // 无 Fake-IP 劫持时：直接保留原域名（不发额外外部 DNS），仍剔除停服 stun.qq.com
    let directCalls = 0;
    const resolvedClean = await resolveDirectStunIceServers(
      [{ urls: ["stun:stun.miwifi.com:3478", "stun:stun.qq.com:3478"] }],
      {
        useCache: false,
        systemLookup: async () => "111.206.174.2",
        directResolve4: async () => {
          directCalls += 1;
          return [];
        },
      },
    );
    expect(directCalls).toBe(0);
    expect(resolvedClean[0]?.urls).toEqual([
      "stun:stun.chat.bilibili.com:3478",
      "stun:stun.miwifi.com:3478",
    ]);

    // ICE 动态重提名从 TURN 升级为 P2P 直连时，立即恢复满血码率上限
    const bitrates: number[] = [];
    const bc = new LossBasedBitrateController({
      maxBps: 8_500_000,
      onChange: (bps) => bitrates.push(bps),
    });
    bc.setRelayMode(true);
    expect(bc.targetBps).toBe(Math.round(8_500_000 * 0.42));
    bc.setRelayMode(false);
    expect(bc.targetBps).toBe(8_500_000);
    expect(bitrates.at(-1)).toBe(8_500_000);
  });
});
