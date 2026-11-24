import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { DeckTelegramActionBody, DeckTelegramStatusResponse } from "@you-brain/core/http/types.js";

import type { BrowserDaemon } from "../../../src/api/client.js";
import { ToastProvider } from "../../../src/components/toast.js";
import { DaemonProvider } from "../../../src/daemon-context.js";
import { TelegramSection, submitRelayEnroll } from "../../../src/pages/settings/telegram.js";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "http://127.0.0.1:4802" } },
  });
});

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

const ENROLLED_STATUS: DeckTelegramStatusResponse = {
  configured: true,
  bot: { username: "ubrain_bot", name: "U-Brain" },
  connection: "ok",
  error: null,
  bound: { name: "John" },
  notificationsEnabled: true,
  pairing: null,
  relay: {
    url: "https://relay.example.com",
    name: "工作室 Mac",
    devices: [{ name: "工作室 Mac", online: true, self: true }],
  },
};

describe("TelegramSection 中转邀请码入网", () => {
  test("提交后调用 enroll-relay，立即清空邀请码输入，且页面不回显邀请码", async () => {
    const secretCode = "ZXCV7890";
    let codeInput = secretCode;
    const calls: DeckTelegramActionBody[] = [];

    const result = await submitRelayEnroll({
      input: {
        url: "  https://relay.example.com  ",
        code: ` ${secretCode} `,
        name: "  工作室 Mac ",
      },
      clearCode: () => {
        codeInput = "";
      },
      action: async (body) => {
        // 提交发出时输入框必须已被清空
        expect(codeInput).toBe("");
        calls.push(body);
        return ENROLLED_STATUS;
      },
    });

    expect(result.submitted).toBe(true);
    expect(result.ok).toBe(true);
    expect(codeInput).toBe("");
    expect(calls).toEqual([
      {
        action: "enroll-relay",
        url: "https://relay.example.com",
        code: secretCode,
        name: "工作室 Mac",
      },
    ]);

    // 渲染入网后的页面：显示「已入网」，绝不出现邀请码
    const html = renderToStaticMarkup(
      <DaemonProvider>
        <ToastProvider>
          <TelegramSection
            client={{} as unknown as BrowserDaemon}
            initialStatus={result.status ?? ENROLLED_STATUS}
            initialEnrolled={true}
          />
        </ToastProvider>
      </DaemonProvider>,
    );
    expect(html).toContain("已入网");
    expect(html).not.toContain(secretCode);
  });

  test("入网失败时同样清空输入框并屏蔽错误消息中可能出现的邀请码", async () => {
    const secretCode = "QWER4567";
    let codeInput = secretCode;

    const result = await submitRelayEnroll({
      input: { url: "https://relay.example.com", code: secretCode },
      clearCode: () => {
        codeInput = "";
      },
      action: async () => {
        throw new Error(`无效邀请码 ${secretCode}`);
      },
    });

    expect(result.submitted).toBe(true);
    expect(result.ok).toBe(false);
    expect(codeInput).toBe("");
    expect(result.error).not.toContain(secretCode);
  });

  test("未入网时仅展示邀请码入网入口与云盘自动同步说明，不再展示旧共享密钥入口", () => {
    const html = renderToStaticMarkup(
      <DaemonProvider>
        <ToastProvider>
          <TelegramSection
            client={{} as unknown as BrowserDaemon}
            initialStatus={{
              configured: false,
              bot: null,
              connection: "off",
              error: null,
              bound: null,
              notificationsEnabled: false,
              pairing: null,
              relay: null,
            }}
            initialEnrolled={false}
          />
        </ToastProvider>
      </DaemonProvider>,
    );

    expect(html).toContain("用邀请码入网");
    expect(html).toContain('id="telegram-enroll-code"');
    expect(html).toMatch(/id="telegram-enroll-code"[^>]*type="password"/);
    expect(html).not.toContain('id="telegram-relay-key"');
    expect(html).not.toContain("u-brain-relay:");
  });
});
