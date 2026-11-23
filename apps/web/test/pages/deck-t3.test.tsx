import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DaemonProvider } from "../../src/daemon-context.js";
import { prefs } from "../../src/lib/prefs.js";
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

describe("DeckT3Panel 多端点渲染", () => {
  test("仅有本机端点时也显示端点切换栏，并高亮本机", () => {
    const html = renderToStaticMarkup(
      <DaemonProvider>
        <DeckT3Panel
          reloadVersion={0}
          settingsOpen={false}
          onSettingsChange={() => {}}
          onReload={() => {}}
          threadUrl={null}
        />
      </DaemonProvider>,
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("本机");
    expect(html).toContain("deck-t3-add-trigger");
    // 只挂载当前激活的 1 个面板
    expect(html.match(/class="deck-t3-pane"/g)).toHaveLength(1);
  });

  test("配置多个端点并选中远端时高亮远端，未选中的端点暂不挂载；有深链时强制切回本机", () => {
    prefs.setItem(
      T3_ENDPOINTS_KEY,
      JSON.stringify([
        { id: "ep-3774", name: "VPS", url: "http://127.0.0.1:3774/" },
        { id: "ep-3775", name: "工作室 Mac", url: "http://127.0.0.1:3775/" },
      ]),
    );
    prefs.setItem(T3_ACTIVE_KEY, "ep-3774");

    const remoteHtml = renderToStaticMarkup(
      <DaemonProvider>
        <DeckT3Panel
          reloadVersion={0}
          settingsOpen={false}
          onSettingsChange={() => {}}
          onReload={() => {}}
          threadUrl={null}
        />
      </DaemonProvider>,
    );
    expect(remoteHtml).toContain("本机");
    expect(remoteHtml).toContain("VPS");
    expect(remoteHtml).toContain("工作室 Mac");
    expect(remoteHtml).toMatch(/aria-selected="true"[^>]*title="http:\/\/127\.0\.0\.1:3774\/"/);
    // 首次渲染只挂载当前激活的 1 个端点面板（懒挂载）
    expect(remoteHtml.match(/class="deck-t3-pane"/g)).toHaveLength(1);

    const deepLinkHtml = renderToStaticMarkup(
      <DaemonProvider>
        <DeckT3Panel
          reloadVersion={0}
          settingsOpen={false}
          onSettingsChange={() => {}}
          onReload={() => {}}
          threadUrl="http://127.0.0.1:3773/env/thread-1"
        />
      </DaemonProvider>,
    );
    expect(deepLinkHtml).toMatch(/aria-selected="true"[^>]*title="http:\/\/127\.0\.0\.1:3773\/"/);
  });

  test("DeckTty7Panel 在远端设备模式展示设备标签，DeckTty7NewForm 隐藏本机目录选择按钮", async () => {
    const { ToastProvider } = await import("../../src/components/toast.js");
    const { DeckTty7Panel } = await import("../../src/pages/deck-tty7.js");
    const { DeckTty7NewForm } = await import("../../src/pages/deck-tty7-list.js");
    const view = {
      available: true as const,
      detail: "",
      sessions: [],
      workspaces: [],
      harnesses: [{ id: "claude", label: "Claude Code" }],
      appearance: null,
    };
    const shared = {
      deviceKey: "vps-1",
      view,
      error: null,
      order: { groups: [], sessions: [] },
      move: () => {},
      reload: async () => view,
    };
    const remotePanel = renderToStaticMarkup(
      <DaemonProvider>
        <ToastProvider>
          <DeckTty7Panel
            sessions={shared}
            device={{ id: "vps-1", name: "VPS 主控" }}
            onClose={() => {}}
            onOpen={() => {}}
            activePane={null}
          />
        </ToastProvider>
      </DaemonProvider>,
    );
    expect(remotePanel).toContain("deck-tty7-device-badge");
    expect(remotePanel).toContain("VPS 主控");

    const localForm = renderToStaticMarkup(
      <DaemonProvider>
        <DeckTty7NewForm view={view} sessions={[]} projectLabel={null} reload={async () => view} onStarted={() => {}} />
      </DaemonProvider>,
    );
    expect(localForm).toContain("选择…");

    const remoteForm = renderToStaticMarkup(
      <DaemonProvider>
        <DeckTty7NewForm view={view} sessions={[]} projectLabel={null} reload={async () => view} onStarted={() => {}} deviceId="vps-1" />
      </DaemonProvider>,
    );
    expect(remoteForm).not.toContain("选择…");
  });
});
