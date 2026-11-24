import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DaemonProvider } from "../../src/daemon-context.js";
import { prefs } from "../../src/lib/prefs.js";
import {
  applyZeroPlayoutDelay,
  computeVideoContentBox,
  extractModifiers,
  mapDomMouseButton,
  normalizeVideoPoint,
  normalizeWheelDelta,
} from "../../src/lib/remote-desktop-input.js";
import { T3_ACTIVE_KEY, T3_ENDPOINTS_KEY, T3_URL_KEY } from "../../src/lib/t3-endpoints.js";
import { DeckT3Panel } from "../../src/pages/deck-t3.js";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "http://127.0.0.1:4802" } },
  });
  prefs.removeItem(T3_URL_KEY);
  prefs.removeItem(T3_ENDPOINTS_KEY);
  prefs.removeItem(T3_ACTIVE_KEY);
});

afterEach(() => {
  prefs.removeItem(T3_URL_KEY);
  prefs.removeItem(T3_ENDPOINTS_KEY);
  prefs.removeItem(T3_ACTIVE_KEY);
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("remote-desktop-input 坐标与低延迟参数辅助函数", () => {
  test("computeVideoContentBox + normalizeVideoPoint 精确排除黑边（letterbox / pillarbox）", () => {
    // 16:9 画面放入 1000x1000 正方形容器 -> 上下各 218.75px 黑边
    const box = computeVideoContentBox(1000, 1000, 1920, 1080);
    expect(box.left).toBe(0);
    expect(box.width).toBe(1000);
    expect(Math.round(box.height)).toBe(563);
    expect(Math.round(box.top)).toBe(219);

    // 点击上黑边应钳制到 y=0，点击正中应映射为 (0.5, 0.5)
    expect(normalizeVideoPoint(500, 50, box)).toEqual({ x: 0.5, y: 0 });
    const center = normalizeVideoPoint(500, 500, box);
    expect(center.x).toBeCloseTo(0.5, 4);
    expect(center.y).toBeCloseTo(0.5, 4);
  });

  test("mapDomMouseButton、normalizeWheelDelta、extractModifiers 与 applyZeroPlayoutDelay", () => {
    expect(mapDomMouseButton(0)).toBe(0);
    expect(mapDomMouseButton(1)).toBe(1);
    expect(mapDomMouseButton(2)).toBe(2);
    expect(mapDomMouseButton(4)).toBeNull();

    // 行模式（deltaMode=1）按 24px 放大并反转符号匹配 macOS CGEvent
    expect(normalizeWheelDelta(0, 3, 1)).toEqual({ dx: 0, dy: -72 });

    expect(
      extractModifiers({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }),
    ).toEqual({ meta: true, alt: true });

    const fakeReceiver = {} as RTCRtpReceiver & {
      playoutDelayHint?: number;
      jitterBufferTarget?: number;
    };
    applyZeroPlayoutDelay(fakeReceiver);
    expect(fakeReceiver.playoutDelayHint).toBe(0);
    expect(fakeReceiver.jitterBufferTarget).toBe(0);
  });
});

describe("DeckT3Panel 远端设备桌面协同按钮", () => {
  test("仅对开放了 remoteDesktop 的非本机设备渲染桌面画面协同按钮，本机不渲染", () => {
    const html = renderToStaticMarkup(
      <DaemonProvider>
        <DeckT3Panel
          reloadVersion={0}
          settingsOpen={false}
          onSettingsChange={() => {}}
          onReload={() => {}}
          threadUrl={null}
          initialDeviceTabs={[
            {
              id: "device:mac-studio",
              deviceId: "mac-studio",
              name: "工作室 Mac Studio",
              canT3: true,
              canRd: true,
            },
            {
              id: "device:linux-vps",
              deviceId: "linux-vps",
              name: "新加坡 VPS",
              canT3: true,
              canRd: false,
            },
          ]}
        />
      </DaemonProvider>,
    );

    expect(html).toContain("工作室 Mac Studio");
    expect(html).toContain("新加坡 VPS");
    // 只有工作室 Mac Studio 渲染了 .deck-t3-rd-btn
    expect(html.match(/class="deck-t3-rd-btn"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="桌面画面协同：工作室 Mac Studio"');
  });
});
