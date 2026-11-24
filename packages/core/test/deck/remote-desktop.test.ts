import { describe, expect, test } from "bun:test";
import { RTCPeerConnection, RTCRtpCodecParameters, type RtpPacket } from "werift";

import {
  BinaryVideoFrameDecoder,
  extractAvccNalus,
  LowLatencyH264RtpStreamer,
  packetizeH264AccessUnit,
  RemoteDesktopHostManager,
  resolveMacKeyCode,
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
});
