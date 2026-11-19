import { describe, expect, test } from "bun:test";

import { t3FrameMessage, t3FrameSrc } from "../../src/lib/t3-frame.js";

describe("t3FrameSrc", () => {
  test("有转发地址时走转发，会话路径保留", () => {
    const view = { url: "http://127.0.0.1:3773/", frameUrl: "http://127.0.0.1:13773/" };
    expect(t3FrameSrc(view, null)).toBe("http://127.0.0.1:13773/");
    expect(t3FrameSrc(view, "http://127.0.0.1:3773/env-1/thread-1")).toBe("http://127.0.0.1:13773/env-1/thread-1");
  });

  test("会话链接不是这个 T3 的，退回首页；没有转发地址时直连", () => {
    expect(t3FrameSrc({ url: "http://127.0.0.1:3773/", frameUrl: "http://127.0.0.1:13773/" }, "http://evil.test/a/b")).toBe("http://127.0.0.1:13773/");
    expect(t3FrameSrc({ url: "http://127.0.0.1:3773/" }, "http://127.0.0.1:3773/env-1/thread-1")).toBe("http://127.0.0.1:3773/env-1/thread-1");
  });
});

describe("t3FrameMessage", () => {
  const contentWindow = {} as Window;
  const frame = { contentWindow, src: "http://127.0.0.1:13773/env/thread" } as HTMLIFrameElement;
  const origin = "http://127.0.0.1:13773";

  test("识别当前 T3 iframe 的消息", () => {
    expect(t3FrameMessage({ source: contentWindow, origin, data: { type: "u-brain:t3-ref:open" } }, frame)).toBe("open");
    expect(t3FrameMessage({ source: contentWindow, origin, data: { type: "u-brain:t3-ref:ready" } }, frame)).toBe("ready");
    expect(t3FrameMessage({ source: contentWindow, origin, data: { type: "u-brain:theme:request" } }, frame)).toBe("theme-request");
    expect(t3FrameMessage({ source: contentWindow, origin, data: { type: "u-brain:t3-ref:shortcut" } }, frame)).toBe("shortcut");
  });

  test("别的窗口、别的源、未知消息一律忽略", () => {
    expect(t3FrameMessage({ source: {} as Window, origin, data: { type: "u-brain:t3-ref:open" } }, frame)).toBeNull();
    expect(t3FrameMessage({ source: contentWindow, origin: "http://127.0.0.1:3773", data: { type: "u-brain:t3-ref:open" } }, frame)).toBeNull();
    expect(t3FrameMessage({ source: contentWindow, origin, data: { type: "other" } }, frame)).toBeNull();
    expect(t3FrameMessage({ source: contentWindow, origin, data: { type: "u-brain:t3-ref:open" } }, null)).toBeNull();
  });
});
