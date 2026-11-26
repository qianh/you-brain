import { describe, expect, test } from "bun:test";
import { RTCPeerConnection, RTCRtpCodecParameters, type RtpPacket } from "werift";

import {
  addFlexfecSsrcToSdp,
  BinaryVideoFrameDecoder,
  buildFlexfecPayload,
  flexfecPayloadTypeOf,
  recoverFlexfecPacket,
  computePipelineStats,
  extractAvccNalus,
  fecGroupSize,
  inspectLocalIceInterfaces,
  interleaveFecGroups,
  KeyframeGate,
  keyframeMinIntervalMs,
  NackRateMeter,
  RtpSendHistory,
  WheelStreamDecoder,
  isBlockedIceCandidateLine,
  LossBasedBitrateController,
  nextStreamTier,
  streamProfileFor,
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
import { MACOS_UI_BRIDGE_SWIFT } from "../../src/deck/remote-desktop/macos-ui-swift.js";

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
    // 积压时清掉的 3 帧加上触发丢弃的那一帧
    expect(streamer.counters).toEqual({ sent: 1, dropped: 4, fecSent: 0 });

    // 丢帧后等待关键帧期间到达的 P 帧也计入丢弃；关键帧到来后恢复发送
    streamer.enqueue(pFrame(83_333));
    expect(streamer.counters.dropped).toBe(5);
    streamer.enqueue({ ...pFrame(100_000), keyframe: true, avcc: makeAvcc([Buffer.from([0x65, 0x01])]) });
    await new Promise((res) => setTimeout(res, 20));
    expect(streamer.counters).toEqual({ sent: 2, dropped: 5, fecSent: 0 });
    streamer.close();
  });

  test("FlexFEC 修复包能恢复组内任意 1 个丢失的媒体包", () => {
    const ssrc = 0x0a0b0c0d;
    const packets = [5, 300, 1180, 17].map((len, i) => {
      const pkt = Buffer.alloc(12 + len);
      pkt[0] = 0x80;
      pkt[1] = (i === 3 ? 0x80 : 0) | 98;
      pkt.writeUInt16BE((65534 + i) & 0xffff, 2); // 跨越序号回绕
      pkt.writeUInt32BE(123456, 4);
      pkt.writeUInt32BE(ssrc, 8);
      for (let j = 12; j < pkt.length; j += 1) pkt[j] = (j * 7 + i) & 0xff;
      return pkt;
    });
    const fec = buildFlexfecPayload(packets, ssrc);
    expect(fec.length).toBe(20 + 1180);
    for (let lost = 0; lost < packets.length; lost += 1) {
      const received = packets.filter((_, i) => i !== lost);
      expect(recoverFlexfecPacket(fec, received, ssrc)?.equals(packets[lost]!)).toBe(true);
    }
    // 丢 2 个无法恢复
    expect(recoverFlexfecPacket(fec, packets.slice(2), ssrc)).toBeNull();
  });

  test("LowLatencyH264RtpStreamer 按丢包率调整 FEC 分组并交织，连续丢 2 包也能恢复", async () => {
    const sentBytes = new Map<number, Buffer>();
    const repairs: Array<{ payload: Buffer; timestamp: number }> = [];
    const streamer = new LowLatencyH264RtpStreamer(
      {
        ssrc: 0x01020304,
        payloadType: 98,
        sendRtp(pkt) {
          sentBytes.set(pkt.header.sequenceNumber, pkt.serialize());
        },
        fec: {
          sentPacket: (seq) => sentBytes.get(seq) ?? null,
          sendRepair(payload, timestamp) {
            repairs.push({ payload, timestamp });
          },
        },
      },
      { sleep: async () => {} },
    );
    const bigSlice = Buffer.alloc(1180 * 5, 0x5a);
    bigSlice[0] = 0x41;
    const frame = (ptsUs: number) => ({ keyframe: false, ptsUs, sps: null, pps: null, avcc: makeAvcc([bigSlice]) });
    // 无丢包：6 个 FU-A 一组（组大小 8）→ 1 个修复包
    streamer.enqueue(frame(0));
    await new Promise((res) => setTimeout(res, 20));
    expect(sentBytes.size).toBe(6);
    expect(repairs).toHaveLength(1);

    // 5% 丢包：组大小 4 → 6 包交织成 2 组：[0,2,4]、[1,3,5]
    streamer.setLossHint(0.05);
    sentBytes.clear();
    repairs.length = 0;
    streamer.enqueue(frame(33_333));
    await new Promise((res) => setTimeout(res, 20));
    expect(repairs).toHaveLength(2);
    expect(streamer.counters.fecSent).toBe(3);
    const all = [...sentBytes.values()];
    // 连续丢第 4、5 个包：分别落在两组里，各自恢复
    expect(recoverFlexfecPacket(repairs[0]!.payload, [all[0]!, all[2]!], 0x01020304)?.equals(all[4]!)).toBe(true);
    expect(recoverFlexfecPacket(repairs[1]!.payload, [all[1]!, all[3]!], 0x01020304)?.equals(all[5]!)).toBe(true);
    streamer.close();
  });

  test("FEC 分组：丢包越多组越小，关键帧更密；交织跨度不超过 15 个序号", () => {
    expect(fecGroupSize(0, false)).toBe(8);
    expect(fecGroupSize(0.05, false)).toBe(4);
    expect(fecGroupSize(0.2, false)).toBe(3);
    expect(fecGroupSize(0, true)).toBe(4);
    expect(fecGroupSize(0.05, true)).toBe(2);
    const idx = Array.from({ length: 14 }, (_, i) => i);
    const groups = interleaveFecGroups(idx, 2);
    expect(groups).toHaveLength(7);
    expect(groups[0]).toEqual([0, 7]);
    for (const g of groups) expect(g[g.length - 1]! - g[0]!).toBeLessThan(15);
    expect(interleaveFecGroups([0, 1, 2], 4)).toEqual([[0, 1, 2]]);
  });

  test("KeyframeGate 忽略在途关键帧期间的 PLI，合并重复请求", () => {
    let now = 0;
    let sent = 0;
    const timers: Array<{ at: number; fn: () => void } | null> = [];
    const gate = new KeyframeGate({
      send: () => (sent += 1),
      now: () => now,
      setTimer: (fn, ms) => timers.push({ at: now + ms, fn }) - 1,
      clearTimer: (h) => {
        timers[h as number] = null;
      },
    });
    const advance = (ms: number) => {
      now += ms;
      for (const [i, t] of timers.entries()) {
        if (t && t.at <= now) {
          timers[i] = null;
          t.fn();
        }
      }
    };
    gate.force();
    expect(sent).toBe(1);
    // 关键帧还没出：PLI 忽略
    advance(100);
    gate.request("pli", 300);
    expect(sent).toBe(1);
    // 关键帧出了，RTT 内到达的 PLI 是针对旧丢包的，忽略
    gate.noteKeyframe();
    advance(200);
    gate.request("pli", 300);
    expect(sent).toBe(1);
    // RTT 之后仍 PLI：延后到最小间隔（3×RTT+200=1100ms）再发，期间的重复请求合并
    advance(300);
    gate.request("pli", 300);
    gate.request("drop", 300);
    expect(sent).toBe(1);
    advance(599);
    expect(sent).toBe(1);
    advance(1);
    expect(sent).toBe(2);
    expect(gate.counters).toEqual({ sent: 2, ignored: 3, deferred: 1 });
    // 延后期间编码器自己出了关键帧：取消延后请求
    gate.noteKeyframe();
    advance(500);
    gate.request("drop", 300);
    gate.noteKeyframe();
    advance(2_000);
    expect(sent).toBe(2);
    expect(keyframeMinIntervalMs(null)).toBe(1_100);
    expect(keyframeMinIntervalMs(2_000)).toBe(3_000);
  });

  test("WheelStreamDecoder 按累计总量滚动：丢包补回距离、乱序旧包丢弃、兼容旧版增量", () => {
    const decoder = new WheelStreamDecoder();
    // 首条：以自带增量起步
    expect(decoder.decode({ t: "wh", dx: 0, dy: -10, ws: "a", s: 1, tx: 0, ty: -10 })).toEqual({ dx: 0, dy: -10 });
    // 第 2 条丢失（ty=-25），第 3 条到达时补回两条的距离
    expect(decoder.decode({ t: "wh", dx: 0, dy: -5, ws: "a", s: 3, tx: 0, ty: -30 })).toEqual({ dx: 0, dy: -20 });
    // 晚到的第 2 条丢弃
    expect(decoder.decode({ t: "wh", dx: 0, dy: -15, ws: "a", s: 2, tx: 0, ty: -25 })).toBeNull();
    // 尾部补发：总量不变，不再滚动
    expect(decoder.decode({ t: "wh", dx: 0, dy: 0, ws: "a", s: 4, tx: 0, ty: -30 })).toBeNull();
    // 新的滚动流（控制端重连）：以自带增量重新起步
    expect(decoder.decode({ t: "wh", dx: 3, dy: 0, ws: "b", s: 1, tx: 3, ty: 0 })).toEqual({ dx: 3, dy: 0 });
    // 旧版控制端：只有增量
    expect(decoder.decode({ t: "wh", dx: 1.5, dy: 2 })).toEqual({ dx: 1.5, dy: 2 });
    expect(decoder.decode({ t: "wh", dx: 0, dy: 0 })).toBeNull();
  });

  test("RtpSendHistory 按序号取回，被覆盖后返回 undefined；NackRateMeter 去重计比例", () => {
    const history = new RtpSendHistory<string>(4);
    history.put(65_535, "a");
    history.put(0, "b");
    expect(history.get(65_535)).toBe("a");
    history.put(65_535 + 4 - 65_536, "c"); // 序号 3 与 65535 同槽（65535 % 4 = 3）
    expect(history.get(65_535)).toBeUndefined();
    expect(history.get(3)).toBe("c");

    const meter = new NackRateMeter();
    meter.noteSent(10);
    meter.noteNack([1, 2]);
    expect(meter.take()).toBe(0); // 样本不足，继续累积
    meter.noteSent(30);
    meter.noteNack([2, 3, 4, 5]);
    expect(meter.take()).toBeCloseTo(5 / 40);
    meter.noteSent(25);
    expect(meter.take()).toBe(0);
  });

  test("addFlexfecSsrcToSdp 为修复流声明独立 SSRC 并分组", () => {
    const sdp = ["m=video 9 UDP/TLS/RTP/SAVPF 98 39", "a=rtpmap:98 H264/90000", "a=rtpmap:39 flexfec-03/90000", "a=ssrc:111 cname:abc", "a=ssrc:111 msid:s t", ""].join("\r\n");
    expect(flexfecPayloadTypeOf(sdp)).toBe(39);
    const out = addFlexfecSsrcToSdp(sdp, 111, 222).split("\r\n");
    expect(out).toEqual([
      "m=video 9 UDP/TLS/RTP/SAVPF 98 39",
      "a=rtpmap:98 H264/90000",
      "a=rtpmap:39 flexfec-03/90000",
      "a=ssrc-group:FEC-FR 111 222",
      "a=ssrc:111 cname:abc",
      "a=ssrc:222 cname:abc",
      "a=ssrc:111 msid:s t",
      "a=ssrc:222 msid:s t",
      "",
    ]);
    expect(flexfecPayloadTypeOf("a=rtpmap:98 H264/90000")).toBeNull();
  });

  test("computePipelineStats converts cumulative counters into per-second rates", () => {
    const profile = { maxDimension: 1440, fps: 30 };
    const prev = { at: 0, host: { captured: 10, busy: 0, dropped: 2, encoded: 8 }, sent: 8, dropped: 0 };
    const cur = { at: 2_000, host: { captured: 70, busy: 4, dropped: 22, encoded: 44 }, sent: 40, dropped: 3 };
    expect(computePipelineStats(prev, cur, profile)).toEqual({
      targetFps: 30,
      maxDimension: 1440,
      captured: 30,
      encoderBusy: 2,
      encoderDropped: 10,
      encoded: 18,
      sent: 16,
      sendDropped: 1.5,
    });
    // 助手重启计数归零：宿主侧数据记为 null，不出现负数
    const restarted = computePipelineStats(cur, { ...cur, at: 4_000, host: { captured: 5, busy: 0, dropped: 0, encoded: 5 } }, profile);
    expect(restarted?.captured).toBeNull();
    expect(restarted?.encoded).toBeNull();
    // 旧版助手没有计数
    expect(computePipelineStats({ ...prev, host: null }, cur, profile)?.captured).toBeNull();
    expect(computePipelineStats(prev, { ...cur, at: 0 }, profile)).toBeNull();
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
    // 浏览器 mDNS 隐私保护下 srflx / relay 的 raddr 是 0.0.0.0 / :: 占位，必须保留，否则跨网 P2P 与 TURN 全断
    expect(
      isBlockedIceCandidateLine(
        "candidate:6 1 udp 1677729535 61.174.30.194 40159 typ srflx raddr 0.0.0.0 rport 0 generation 0",
        inspected.blockedIps,
      ),
    ).toBe(false);
    expect(
      isBlockedIceCandidateLine(
        "candidate:7 1 udp 41885439 107.174.154.253 50000 typ relay raddr 0.0.0.0 rport 0 generation 0",
        inspected.blockedIps,
      ),
    ).toBe(false);
    expect(
      isBlockedIceCandidateLine(
        "candidate:8 1 udp 1677729535 2409:8a00:1234::99 40160 typ srflx raddr :: rport 0",
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

describe("RemoteDesktopHostManager 远端候选投递", () => {
  test("同批到达的结束标记不抢跑，且 raddr 0.0.0.0 的浏览器候选仍能配对建连", async () => {
    const snapshot: HostStateSnapshot = {
      displays: [{ id: 1, name: "Main", width: 1280, height: 800, scaleFactor: 2, primary: true }],
      activeDisplayId: 1,
      permissions: { screenRecording: true, accessibility: true },
    };
    const mockBridge: RemoteDesktopHostBridge = {
      async ensureStarted() {
        return snapshot;
      },
      async configure() {
        return snapshot;
      },
      getStateSnapshot() {
        return snapshot;
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
      // 模拟系统 mDNS 解析耗时：旧实现里结束标记会趁这段时间先送进 werift。
      mdnsLookup: () => new Promise((resolve) => setTimeout(() => resolve("127.0.0.1"), 50)),
    });

    const states: string[] = [];
    const ready = new Promise<void>((resolve, reject) => {
      manager.setSignalingEvents({
        onIce() {},
        onState(_to, _sid, payload) {
          states.push(payload.state);
          if (payload.state === "ready") resolve();
          if (payload.state === "error" || payload.state === "closed") reject(new Error(payload.error ?? payload.state));
        },
      });
    });

    const clientPc = new RTCPeerConnection({ iceAdditionalHostAddresses: ["127.0.0.1"] });
    clientPc.addTransceiver("video", { direction: "recvonly" });
    clientPc.createDataChannel("control", { ordered: true });
    const gathered: string[] = [];
    clientPc.onIceCandidate.subscribe((cand) => {
      if (cand?.candidate) gathered.push(cand.candidate);
    });
    const gatherDone = new Promise<void>((resolve) => {
      if (clientPc.iceGatheringState === "complete") resolve();
      clientPc.iceGatheringStateChange.subscribe((st) => {
        if (st === "complete") resolve();
      });
    });
    const offer = await clientPc.createOffer();
    await clientPc.setLocalDescription(offer);
    await gatherDone;

    const openRes = await manager.openSession("peer-web", {
      sessionId: "rd_ice_order_test",
      offerSdp: offer.sdp,
      quality: "hd",
    });
    // 去掉宿主候选，让客户端无法先发检查、宿主也就学不到对端反射候选，只能靠投递来的远端候选配对
    //（对应真实场景里浏览器检查要绕 TURN、到得比宿主判定失败更晚）。
    const answerWithoutCandidates = openRes.answerSdp
      .split(/\r?\n/u)
      .filter((line) => !line.startsWith("a=candidate:") && line !== "a=end-of-candidates")
      .join("\r\n");
    await clientPc.setRemoteDescription({ type: "answer", sdp: answerWithoutCandidates });

    // 浏览器隐私模式：127.0.0.1 换成 .local 主机名，raddr 一律为 0.0.0.0；结束标记与候选同批到达。
    const browserLike = gathered
      .filter((c) => / 127\.0\.0\.1 /u.test(c))
      .map((c) => `${c.replace(" 127.0.0.1 ", " 0d2c7f1e-1111-2222-3333-444455556666.local ")} raddr 0.0.0.0 rport 0`);
    expect(browserLike.length).toBeGreaterThan(0);
    await manager.addIceCandidates("peer-web", {
      sessionId: openRes.sessionId,
      candidates: [...browserLike.map((candidate) => ({ candidate, sdpMid: "0", sdpMLineIndex: 0 })), { candidate: "" }],
    });

    await Promise.race([
      ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`未建连：${states.join(",")}`)), 10_000)),
    ]);
    expect(states).toContain("ready");

    await manager.closeAll();
    await clientPc.close();
  }, 20_000);
});

describe("LossBasedBitrateController 排队时延感知", () => {
  /** 简单瓶颈模型：码率超过容量时多出的比特进入队列，RTT = 基线 + 排队时延；全程不丢包（代理隧道/中继的典型表现）。 */
  function simulateQueueingLink(bc: LossBasedBitrateController, opts: { capacityBps: number; baseRttMs: number; seconds: number }) {
    let queueBits = 0;
    let maxRtt = 0;
    const rtts: number[] = [];
    const stepMs = 500;
    for (let t = 0; t <= opts.seconds * 1000; t += stepMs) {
      // 报告反映上一段时间积累的排队；控制器调整后，新码率作用于下一段时间
      const rtt = opts.baseRttMs + (queueBits / opts.capacityBps) * 1000;
      maxRtt = Math.max(maxRtt, rtt);
      rtts.push(rtt);
      bc.onRoundTripTime(rtt, t);
      bc.onReceiverReport(0, t);
      queueBits = Math.max(0, queueBits + ((bc.targetBps - opts.capacityBps) * stepMs) / 1000);
    }
    return { maxRtt, rtts };
  }

  test("RR 丢包为 0 但重传比例高时同样降码率（重传补洞掩盖了真实丢包）", () => {
    const bc = new LossBasedBitrateController({ maxBps: 4_000_000 });
    for (let t = 0; t <= 3_000; t += 1_000) bc.onReceiverReport(0, t, 0.08);
    expect(bc.targetBps).toBeLessThan(4_000_000 * 0.88 * 0.88);
    expect(bc.lastLoss).toBeCloseTo(0.08);
    // 只看 RR 时不会降
    const rrOnly = new LossBasedBitrateController({ maxBps: 4_000_000 });
    for (let t = 0; t <= 3_000; t += 1_000) rrOnly.onReceiverReport(0, t);
    expect(rrOnly.targetBps).toBe(4_000_000);
  });

  test("不丢包但排队时按 RTT 降码率，不会排出秒级延迟", () => {
    const bc = new LossBasedBitrateController({ maxBps: 8_500_000 });
    bc.setRelayMode(true);
    const { maxRtt, rtts } = simulateQueueingLink(bc, { capacityBps: 1_500_000, baseRttMs: 340, seconds: 60 });
    // 只看丢包时这条链路会一路排到数十秒；现在起步过冲的峰值也应压在 1.5 秒以内，稳定后回到基线附近
    expect(maxRtt).toBeLessThan(1_500);
    const tail = rtts.slice(-20);
    expect(Math.max(...tail)).toBeLessThan(340 + 250);
    // 容量低于按比例算的下限（8.5M×20%=1.7M）时，也要能降到容量附近（允许围绕容量小幅探测）
    expect(bc.targetBps).toBeLessThanOrEqual(1_500_000 * 1.15);
    expect(bc.lastRttMs).not.toBeNull();
  });

  test("RTT 平稳时不误降，可升回上限；切换链路后重新学习基线", () => {
    const bc = new LossBasedBitrateController({ maxBps: 8_500_000 });
    bc.setRelayMode(true);
    simulateQueueingLink(bc, { capacityBps: 50_000_000, baseRttMs: 340, seconds: 60 });
    expect(bc.targetBps).toBe(8_500_000);

    // 直连基线 20ms 学习一段后切到中继（基线 340ms）：不能把新链路的高基线误判为排队
    const direct = new LossBasedBitrateController({ maxBps: 8_500_000 });
    for (let t = 0; t < 5_000; t += 500) direct.onRoundTripTime(20, t);
    direct.setRelayMode(true);
    const before = direct.targetBps;
    for (let t = 5_000; t < 8_000; t += 500) direct.onRoundTripTime(340, t);
    expect(direct.targetBps).toBe(before);
  });
});

describe("中继链路降帧率与分辨率档位", () => {
  test("直连用画质预设；中继收紧到 1440/30；码率很低再降到 1152/24，且不超过所选画质", () => {
    const hd = { maxDimension: 1920, fps: 60 };
    const smooth = { maxDimension: 1600, fps: 60 };
    expect(streamProfileFor("direct", hd)).toEqual({ maxDimension: 1920, fps: 60 });
    expect(streamProfileFor("relay", hd)).toEqual({ maxDimension: 1440, fps: 30 });
    expect(streamProfileFor("relay-low", hd)).toEqual({ maxDimension: 1152, fps: 24 });
    // 所选画质本身更低时不会被放大
    expect(streamProfileFor("relay", { maxDimension: 1280, fps: 25 })).toEqual({ maxDimension: 1280, fps: 25 });
    expect(streamProfileFor("relay", smooth)).toEqual({ maxDimension: 1440, fps: 30 });
  });

  test("档位切换：直连/中继立即切换；中继内的高低档有回差和最短停留时间", () => {
    const base = { nowMs: 100_000, changedAtMs: 0 };
    expect(nextStreamTier({ ...base, current: "relay", relay: false, targetBps: 500_000 })).toBe("direct");
    expect(nextStreamTier({ ...base, current: "direct", relay: true, targetBps: 3_000_000 })).toBe("relay");
    expect(nextStreamTier({ ...base, current: "direct", relay: true, targetBps: 800_000 })).toBe("relay-low");

    // 码率低于 1M 进入低档，但刚切换过（不足 10 秒）时先保持
    expect(nextStreamTier({ ...base, current: "relay", relay: true, targetBps: 900_000 })).toBe("relay-low");
    expect(
      nextStreamTier({ current: "relay", relay: true, targetBps: 900_000, nowMs: 105_000, changedAtMs: 100_000 }),
    ).toBe("relay");
    // 回差：1M~1.6M 之间保持原档，不来回切
    expect(nextStreamTier({ ...base, current: "relay-low", relay: true, targetBps: 1_300_000 })).toBe("relay-low");
    expect(nextStreamTier({ ...base, current: "relay", relay: true, targetBps: 1_300_000 })).toBe("relay");
    expect(nextStreamTier({ ...base, current: "relay-low", relay: true, targetBps: 1_700_000 })).toBe("relay");
  });

  test("低 RTT 的国内中继放开到画质预设；RTT 变高或码率掉下来再收紧", () => {
    const base = { nowMs: 100_000, changedAtMs: 0, relay: true };
    const hd = { maxDimension: 1920, fps: 60 };
    expect(streamProfileFor("relay-fast", hd)).toEqual({ maxDimension: 1920, fps: 60 });

    // RTT 35ms、码率充足 → relay-fast
    expect(nextStreamTier({ ...base, current: "relay", targetBps: 3_000_000, rttMs: 35 })).toBe("relay-fast");
    // RTT 未知或偏高（跨境中继）时保持 relay
    expect(nextStreamTier({ ...base, current: "relay", targetBps: 3_000_000, rttMs: null })).toBe("relay");
    expect(nextStreamTier({ ...base, current: "relay", targetBps: 3_000_000 })).toBe("relay");
    expect(nextStreamTier({ ...base, current: "relay", targetBps: 3_000_000, rttMs: 200 })).toBe("relay");
    // 码率还没爬上来时不放开
    expect(nextStreamTier({ ...base, current: "relay", targetBps: 1_500_000, rttMs: 35 })).toBe("relay");
    // 刚切过档（不足 10 秒）保持
    expect(
      nextStreamTier({ current: "relay", relay: true, targetBps: 3_000_000, rttMs: 35, nowMs: 105_000, changedAtMs: 100_000 }),
    ).toBe("relay");

    // 回差：RTT 80~150、码率 1.2M~2M 之间保持 relay-fast
    expect(nextStreamTier({ ...base, current: "relay-fast", targetBps: 1_500_000, rttMs: 120 })).toBe("relay-fast");
    expect(nextStreamTier({ ...base, current: "relay-fast", targetBps: 3_000_000, rttMs: 180 })).toBe("relay");
    expect(nextStreamTier({ ...base, current: "relay-fast", targetBps: 1_100_000, rttMs: 35 })).toBe("relay");
    expect(nextStreamTier({ ...base, current: "relay-fast", targetBps: 800_000, rttMs: 35 })).toBe("relay-low");
    // 切回直连立即生效
    expect(nextStreamTier({ ...base, current: "relay-fast", relay: false, targetBps: 800_000 })).toBe("direct");
  });

  test("码率控制器给出窗口内的基线 RTT", () => {
    const bc = new LossBasedBitrateController({ maxBps: 4_000_000 });
    expect(bc.baseRttMs).toBeNull();
    bc.onRoundTripTime(40, 0);
    bc.onRoundTripTime(35, 500);
    bc.onRoundTripTime(90, 1_000);
    expect(bc.baseRttMs).toBe(35);
  });
});

describe("macOS 宿主滚动方向", () => {
  test("协议 dx/dy 已是 CGEvent 方向，宿主不再二次取反", () => {
    expect(MACOS_UI_BRIDGE_SWIFT).toContain("scrollRemainderY += dy");
    expect(MACOS_UI_BRIDGE_SWIFT).toContain("scrollRemainderX += dx");
    expect(MACOS_UI_BRIDGE_SWIFT).not.toContain("+= -dy");
    expect(MACOS_UI_BRIDGE_SWIFT).not.toContain("+= -dx");
  });
});
