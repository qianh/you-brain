import { describe, expect, test } from "bun:test";

import {
  ClickCounter,
  ClipboardAssembler,
  REMOTE_KEY_COMBOS,
  TrailingThrottle,
  chunkText,
  expandKeyCombo,
  isImeKeyEvent,
  isMacPlatform,
  mapKeyForRemote,
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

  test("TrailingThrottle 间隔内只发最新值，flush 补发尾帧", () => {
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
    now = 10;
    throttle.push(4);
    expect(sent).toEqual([1, 3, 4]);
    throttle.cancel();
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
});
