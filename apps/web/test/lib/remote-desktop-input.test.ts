import { describe, expect, test } from "bun:test";

import {
  ClickCounter,
  ClipboardAssembler,
  REMOTE_KEY_COMBOS,
  TrailingThrottle,
  ZOOM_MAX,
  ZOOM_MIN,
  chunkText,
  clampZoom,
  computeAnchoredZoomScroll,
  computeZoomedSurfaceSize,
  expandKeyCombo,
  isBlockedBrowserIceCandidate,
  isImeKeyEvent,
  isMacPlatform,
  mapKeyForRemote,
  prepareSdpForDirectP2p,
  roundNormalizedCoord,
  stepZoom,
  summarizeRtcStats,
} from "../../src/lib/remote-desktop-input.js";
import { RemoteFileClient, type FileChannelLike } from "../../src/lib/remote-desktop-files.js";

describe("远程桌面输入工具", () => {
  test("ClickCounter 按间隔与位移统计连击，最多三击", () => {
    const counter = new ClickCounter();
    expect(counter.register(0, 10, 10, 0, 500)).toBe(1);
    expect(counter.register(0, 12, 11, 200, 500)).toBe(2);
    expect(counter.register(0, 12, 11, 400, 500)).toBe(3);
    expect(counter.register(0, 12, 11, 500, 500)).toBe(1);
    expect(counter.current).toBe(1);
    // 超时、换键、位移过大都重新计数
    expect(counter.register(0, 12, 11, 1200, 500)).toBe(1);
    expect(counter.register(2, 12, 11, 1300, 500)).toBe(1);
    expect(counter.register(2, 40, 11, 1400, 500)).toBe(1);
  });

  test("chunkText 不拆开代理对，拼回与原文一致", () => {
    const text = `ab${"😀".repeat(5)}cd`;
    const parts = chunkText(text, 3);
    expect(parts.join("")).toBe(text);
    for (const part of parts) {
      const last = part.charCodeAt(part.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    expect(chunkText("short", 10)).toEqual(["short"]);
  });

  test("ClipboardAssembler 乱序分片也能重组", () => {
    const asm = new ClipboardAssembler();
    expect(asm.push({ text: "B", chunk: { id: "x", i: 1, n: 3 } })).toBeNull();
    expect(asm.push({ text: "A", chunk: { id: "x", i: 0, n: 3 } })).toBeNull();
    expect(asm.push({ text: "A", chunk: { id: "x", i: 0, n: 3 } })).toBeNull();
    expect(asm.push({ text: "C", chunk: { id: "x", i: 2, n: 3 } })).toBe("ABC");
    expect(asm.push({ text: "plain" })).toBe("plain");
    // 新 id 丢弃旧的半截
    asm.push({ text: "1", chunk: { id: "old", i: 0, n: 2 } });
    expect(asm.push({ text: "Z", chunk: { id: "new", i: 0, n: 1 } })).toBe("Z");
  });

  test("mapKeyForRemote 互换 Ctrl 与 ⌘", () => {
    const mods = { meta: false, ctrl: true, alt: false, shift: true };
    expect(mapKeyForRemote("ControlLeft", mods, true)).toEqual({
      code: "MetaLeft",
      mods: { meta: true, ctrl: false, alt: false, shift: true },
    });
    expect(mapKeyForRemote("KeyC", mods, false)).toEqual({ code: "KeyC", mods });
  });

  test("isImeKeyEvent 与 isMacPlatform", () => {
    expect(isImeKeyEvent({ keyCode: 229 })).toBe(true);
    expect(isImeKeyEvent({ isComposing: true })).toBe(true);
    expect(isImeKeyEvent({ key: "a", keyCode: 65 })).toBe(false);
    expect(isMacPlatform({ platform: "MacIntel" })).toBe(true);
    expect(isMacPlatform({ platform: "Win32", userAgent: "Windows NT" })).toBe(false);
    expect(isMacPlatform(undefined)).toBe(false);
  });

  test("expandKeyCombo 依次按下、逆序抬起并带上修饰键状态", () => {
    const steps = expandKeyCombo(["MetaLeft", "ShiftLeft", "Digit5"]);
    expect(steps.map((s) => `${s.t}:${s.code}`)).toEqual([
      "kd:MetaLeft",
      "kd:ShiftLeft",
      "kd:Digit5",
      "ku:Digit5",
      "ku:ShiftLeft",
      "ku:MetaLeft",
    ]);
    expect(steps[2]).toMatchObject({ meta: true, shift: true, ctrl: false });
    expect(steps[4]).toMatchObject({ meta: true, shift: false });
    expect(steps[5]).toMatchObject({ meta: false });
    expect(new Set(REMOTE_KEY_COMBOS.map((c) => c.id)).size).toBe(REMOTE_KEY_COMBOS.length);
  });

  test("TrailingThrottle 间隔内只发最新值，支持动态调整间隔与 flush", () => {
    let now = 0;
    const sent: number[] = [];
    const throttle = new TrailingThrottle<number>(4, (v) => sent.push(v), () => now);
    throttle.push(1);
    now = 1;
    throttle.push(2);
    throttle.push(3);
    expect(sent).toEqual([1]);
    throttle.flush();
    expect(sent).toEqual([1, 3]);
    throttle.flush();
    expect(sent).toEqual([1, 3]);
    throttle.setIntervalMs(16);
    now = 10;
    // 距离上次 flush(now=1) 仅过 9ms < 16ms，不会立即发，进入尾帧等待
    throttle.push(4);
    expect(sent).toEqual([1, 3]);
    now = 20;
    throttle.push(5);
    expect(sent).toEqual([1, 3, 5]);
    throttle.cancel();
  });

  test("画面缩放计算：支持缩小(<100%)、放大(>100%)、1:1 与鼠标锚点保位滚动", () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
    expect(clampZoom(1.008)).toBe(1);
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(roundNormalizedCoord(0.123456789)).toBe(0.12346);

    // 默认 fit 100%：不设自定义像素尺寸，不产生滚动条
    const fit100 = computeZoomedSurfaceSize(1200, 800, 1920, 1080, "fit", 1);
    expect(fit100).toEqual({ width: 1200, height: 800, isCustomSize: false, overflows: false });

    // 缩小到 50%：1920x1080 在 1200x800 内 fit 盒为 1200x675，再乘 0.5 -> 600x338，居中无溢出
    const fit50 = computeZoomedSurfaceSize(1200, 800, 1920, 1080, "fit", 0.5);
    expect(fit50).toEqual({ width: 600, height: 338, isCustomSize: true, overflows: false });

    // 放大到 200%：2400x1350 超出 1200x800 视口，启用滚动与平移
    const fit200 = computeZoomedSurfaceSize(1200, 800, 1920, 1080, "fit", 2);
    expect(fit200).toEqual({ width: 2400, height: 1350, isCustomSize: true, overflows: true });

    // 锚点滚动：在 1200x675 画面（视口 1200x800，上下各留白 62.5px）上鼠标指在 (900, 400)，即水平 75%、垂直 50% 处放大到 2400x1350
    const scroll = computeAnchoredZoomScroll({
      viewportWidth: 1200,
      viewportHeight: 800,
      oldWidth: 1200,
      oldHeight: 675,
      newWidth: 2400,
      newHeight: 1350,
      scrollLeft: 0,
      scrollTop: 0,
      anchorX: 900,
      anchorY: 400,
    });
    // 水平：0.75 * 2400 - 900 = 900；垂直：0.5 * 1350 - 400 = 275
    expect(scroll).toEqual({ scrollLeft: 900, scrollTop: 275 });
  });

  test("summarizeRtcStats 计算帧率、码率、丢包与链路", () => {
    const report = (bytes: number, frames: number, lost: number, received: number) => [
      { id: "T", type: "transport", selectedCandidatePairId: "P" },
      { id: "P", type: "candidate-pair", state: "succeeded", currentRoundTripTime: 0.042, localCandidateId: "L", remoteCandidateId: "R" },
      { id: "L", type: "local-candidate", candidateType: "host" },
      { id: "R", type: "remote-candidate", candidateType: "relay" },
      {
        id: "V",
        type: "inbound-rtp",
        kind: "video",
        bytesReceived: bytes,
        framesDecoded: frames,
        packetsLost: lost,
        packetsReceived: received,
        jitterBufferDelay: frames * 0.01,
        jitterBufferEmittedCount: frames,
        totalDecodeTime: frames * 0.002,
        frameWidth: 2560,
        frameHeight: 1600,
      },
    ];
    const first = summarizeRtcStats(report(0, 0, 0, 0), null, 0);
    expect(first.view.rttMs).toBe(42);
    expect(first.view.relay).toBe(true);
    const second = summarizeRtcStats(report(1_000_000, 60, 1, 99), first.sample, 1000);
    expect(second.view.fps).toBe(60);
    expect(second.view.bitrateBps).toBe(8_000_000);
    expect(second.view.lossPct).toBe(1);
    expect(second.view.jitterBufferMs).toBe(10);
    expect(second.view.decodeMs).toBe(2);
    expect(second.view.width).toBe(2560);
  });
});

class FakeChannel implements FileChannelLike {
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = "blob";
  sent: Array<string | Uint8Array> = [];
  #onMessage: ((event: { data: unknown }) => void) | null = null;
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === "string") this.sent.push(data);
    else if (data instanceof ArrayBuffer) this.sent.push(new Uint8Array(data));
    else this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    if (type === "message") this.#onMessage = listener;
  }
  removeEventListener(): void {}
  emit(data: unknown): void {
    this.#onMessage?.({ data });
  }
  json(): Array<Record<string, unknown>> {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("RemoteFileClient", () => {
  test("上传：put → 分片 → end，收到 saved 后完成", async () => {
    const dc = new FakeChannel();
    let items: Array<{ status: string; savedAt?: string }> = [];
    const client = new RemoteFileClient(dc, { onUpdate: (next) => (items = next), sink: async () => undefined });
    const bytes = new Uint8Array(40 * 1024).map((_, i) => i % 251);
    client.upload([new File([bytes], "a.bin")]);
    for (let i = 0; i < 20 && !dc.json().some((m) => m.t === "end"); i += 1) await tick();
    const frames = dc.json();
    expect(frames[0]).toMatchObject({ t: "put", name: "a.bin", size: bytes.byteLength });
    const binary = dc.sent.filter((s): s is Uint8Array => typeof s !== "string");
    expect(binary.map((b) => b.byteLength)).toEqual([16384, 16384, 8192]);
    const id = frames[0]!.id as string;
    dc.emit(JSON.stringify({ t: "saved", id, path: "/Users/x/Downloads/a.bin", name: "a.bin" }));
    await tick();
    expect(items[0]).toMatchObject({ status: "done", savedAt: "/Users/x/Downloads/a.bin" });
    expect(dc.binaryType).toBe("arraybuffer");
  });

  test("下载：meta 之后的分片交给落盘函数，done 时标记完成", async () => {
    const dc = new FakeChannel();
    const chunks: Array<{ offset: number; size: number; final: boolean }> = [];
    let items: Array<{ status: string; transferred: number; savedAt?: string }> = [];
    const client = new RemoteFileClient(dc, {
      onUpdate: (next) => (items = next),
      sink: async ({ offset, chunk, final }) => {
        chunks.push({ offset, size: chunk.size, final });
        return final ? "/local/b.txt" : undefined;
      },
    });
    client.download({ path: "/remote/b.txt", name: "b.txt", size: 6 });
    const get = dc.json().find((m) => m.t === "get")!;
    expect(get.path).toBe("/remote/b.txt");
    const id = get.id as string;
    // meta 之前的残留分片被丢弃
    dc.emit(new Uint8Array([9, 9]).buffer);
    dc.emit(JSON.stringify({ t: "meta", id, name: "b.txt", size: 6 }));
    dc.emit(new Uint8Array([1, 2, 3]).buffer);
    dc.emit(new Uint8Array([4, 5, 6]).buffer);
    dc.emit(JSON.stringify({ t: "done", id }));
    await tick();
    expect(chunks).toEqual([{ offset: 0, size: 6, final: true }]);
    expect(items[0]).toMatchObject({ status: "done", transferred: 6, savedAt: "/local/b.txt" });
  });
  test("剪贴板图片：上传带 dest=clipboard、取回为 PNG Blob，且不出现在传输列表", async () => {
    const dc = new FakeChannel();
    let items: unknown[] = [];
    const client = new RemoteFileClient(dc, { onUpdate: (next) => (items = next), sink: async () => undefined });
    const uploaded = client.uploadClipboardImage(new Blob([new Uint8Array(100)], { type: "image/png" }));
    for (let i = 0; i < 20 && !dc.json().some((m) => m.t === "end"); i += 1) await tick();
    const put = dc.json().find((m) => m.t === "put")!;
    expect(put).toMatchObject({ dest: "clipboard", size: 100 });
    dc.emit(JSON.stringify({ t: "saved", id: put.id, path: "clipboard", name: "clipboard.png" }));
    await uploaded;
    expect(items).toEqual([]);

    const fetched = client.fetchClipboardImage("clipboard:image");
    const get = dc.json().find((m) => m.t === "get")!;
    expect(get.path).toBe("clipboard:image");
    dc.emit(JSON.stringify({ t: "meta", id: get.id, name: "clipboard.png", size: 4 }));
    dc.emit(new Uint8Array([1, 2, 3, 4]).buffer);
    dc.emit(JSON.stringify({ t: "done", id: get.id }));
    const blob = await fetched;
    expect(blob.type).toBe("image/png");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect(items).toEqual([]);

    const failed = client.fetchClipboardImage("clipboard:image");
    const get2 = dc.json().filter((m) => m.t === "get")[1]!;
    dc.emit(JSON.stringify({ t: "error", id: get2.id, message: "没有图片" }));
    await expect(failed).rejects.toThrow("没有图片");
  });

  test("浏览器侧过滤代理 Fake-IP 候选并在 SDP 协商中注入 renomination", () => {
    expect(isBlockedBrowserIceCandidate("candidate:1 1 UDP 2122260223 198.18.0.1 50000 typ host")).toBe(true);
    expect(isBlockedBrowserIceCandidate("candidate:2 1 UDP 2122260223 198.19.12.8 50001 typ host")).toBe(true);
    expect(isBlockedBrowserIceCandidate("candidate:3 1 UDP 2122260223 fd00:1234:ffff::10 50002 typ host")).toBe(true);
    expect(
      isBlockedBrowserIceCandidate(
        "candidate:4 1 UDP 1686052607 216.167.74.66 41000 typ srflx raddr 198.18.0.1 rport 50000",
      ),
    ).toBe(true);
    expect(isBlockedBrowserIceCandidate("candidate:5 1 UDP 2122260223 100.88.1.9 50003 typ host")).toBe(false);
    expect(isBlockedBrowserIceCandidate("candidate:6 1 UDP 2122260223 abcd-1234.local 50004 typ host")).toBe(false);
    // mDNS 隐私保护下浏览器 srflx / relay 的 raddr 固定为 0.0.0.0 / ::，不能当伪地址丢弃
    expect(
      isBlockedBrowserIceCandidate(
        "candidate:7 1 udp 1677729535 61.174.30.194 40159 typ srflx raddr 0.0.0.0 rport 0 generation 0",
      ),
    ).toBe(false);
    expect(
      isBlockedBrowserIceCandidate(
        "candidate:8 1 udp 41885439 107.174.154.253 50000 typ relay raddr 0.0.0.0 rport 0 generation 0",
      ),
    ).toBe(false);
    expect(
      isBlockedBrowserIceCandidate("candidate:9 1 udp 1677729535 2409:8a00:1234::99 40160 typ srflx raddr :: rport 0"),
    ).toBe(false);

    const inputSdp = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=ice-ufrag:abcd",
      "a=ice-pwd:123456789012345678901234",
      "a=ice-options:trickle",
      "a=candidate:1 1 UDP 2122260223 198.18.0.1 50000 typ host",
      "a=candidate:2 1 UDP 2122260223 172.16.202.20 50005 typ host",
      "",
    ].join("\r\n");

    const outputSdp = prepareSdpForDirectP2p(inputSdp);
    expect(outputSdp).toContain("a=ice-options:trickle renomination");
    expect(outputSdp).not.toContain("198.18.0.1");
    expect(outputSdp).toContain("172.16.202.20");
    // 幂等性：重复调用不会重复追加 renomination
    expect(prepareSdpForDirectP2p(outputSdp)).toBe(outputSdp);
  });
});
