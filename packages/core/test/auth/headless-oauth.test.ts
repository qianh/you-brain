import { describe, expect, it } from "bun:test";

import {
  HEADLESS_CALLBACK_PORT,
  describeSshTunnel,
  headlessRedirectUri,
  startHeadlessOAuthLoopback,
} from "../../src/auth/headless-oauth.js";

/** 先挂上 handler，避免后面的 rejection 变成 unhandled。 */
function capture(promise: Promise<string>): Promise<string> {
  const captured = promise.then(
    (value) => value,
    (error: unknown) => Promise.reject(error),
  );
  captured.catch(() => undefined);
  return promise;
}

describe("headless OAuth callback", () => {
  it("listens on the fixed port so an SSH tunnel can be opened in advance", async () => {
    const loopback = await startHeadlessOAuthLoopback("expected-state", {
      printUrl: () => undefined,
      timeoutMs: 1_000,
    });
    try {
      const url = new URL(loopback.redirectUri);
      expect(url.port).toBe(String(HEADLESS_CALLBACK_PORT));
      expect(url.pathname).toBe("/oauth/callback");
      expect(loopback.redirectUri).toBe(headlessRedirectUri(HEADLESS_CALLBACK_PORT));
    } finally {
      await loopback.close();
    }
  });

  it("prints the tunnel command before the authorization URL", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    const loopback = await startHeadlessOAuthLoopback("expected-state", {
      port: 0,
      printUrl: (url) => lines.push(url),
      describeTunnel: (port) => `ssh -N -L ${port}:127.0.0.1:${port} me@server`,
      timeoutMs: 1_000,
    });
    try {
      const pending = capture(loopback.authorize("https://accounts.example/authorize"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const port = new URL(loopback.redirectUri).port;
      expect(lines).toEqual([
        "这台机器没有浏览器。先在你自己的电脑上执行：",
        `  ssh -N -L ${port}:127.0.0.1:${port} me@server`,
        "保持这个终端窗口开着，然后在浏览器里打开下面的链接：",
        "https://accounts.example/authorize",
      ]);
      await loopback.close();
      await expect(pending).rejects.toThrow(/cancelled/);
    } finally {
      console.log = original;
      await loopback.close();
    }
  });

  it("skips the tunnel hint when describeTunnel returns null", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    const loopback = await startHeadlessOAuthLoopback("expected-state", {
      port: 0,
      printUrl: (url) => lines.push(url),
      describeTunnel: () => null,
      timeoutMs: 1_000,
    });
    try {
      const pending = capture(loopback.authorize("https://accounts.example/authorize"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(lines).toEqual(["https://accounts.example/authorize"]);
      await loopback.close();
      await expect(pending).rejects.toThrow(/cancelled/);
    } finally {
      console.log = original;
      await loopback.close();
    }
  });

  it("only opens a browser when the caller supplies one", async () => {
    let opened = 0;
    const loopback = await startHeadlessOAuthLoopback("expected-state", {
      port: 0,
      printUrl: () => undefined,
      openUrl: async () => {
        opened += 1;
      },
      timeoutMs: 1_000,
    });
    try {
      const pending = capture(loopback.authorize("https://accounts.example/authorize"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      // 只有显式传入 openUrl 才会调用；默认路径不碰 xdg-open。
      expect(opened).toBe(1);
      await loopback.close();
      await expect(pending).rejects.toThrow(/cancelled/);
    } finally {
      await loopback.close();
    }
  });

  it("resolves the code from a valid callback and rejects a wrong state", async () => {
    const loopback = await startHeadlessOAuthLoopback("expected-state", {
      port: 0,
      printUrl: () => undefined,
      timeoutMs: 2_000,
    });
    try {
      const pending = capture(loopback.authorize("https://accounts.example/authorize"));
      const wrong = await fetch(`${loopback.redirectUri}?state=nope&code=c`);
      expect(wrong.status).toBe(400);
      await expect(pending).rejects.toThrow(/validation failed/);
    } finally {
      await loopback.close();
    }

    const second = await startHeadlessOAuthLoopback("state-2", {
      port: 0,
      printUrl: () => undefined,
      timeoutMs: 2_000,
    });
    try {
      const pending = second.authorize("https://accounts.example/authorize");
      const ok = await fetch(`${second.redirectUri}?state=state-2&code=the-code`);
      expect(ok.status).toBe(200);
      expect(await pending).toBe("the-code");
    } finally {
      await second.close();
    }
  });
});

describe("ssh tunnel hint", () => {
  it("uses the ssh connection when available", () => {
    expect(
      describeSshTunnel(53682, {
        USER: "john",
        SSH_CONNECTION: "203.0.113.5 51234 198.51.100.7 22",
      }),
    ).toBe("ssh -N -L 53682:127.0.0.1:53682 john@198.51.100.7");
  });

  it("falls back to a readable placeholder", () => {
    expect(describeSshTunnel(53682, {})).toBe("ssh -N -L 53682:127.0.0.1:53682 user@这台服务器");
  });
});

describe("headless callback port conflicts", () => {
  it("explains a busy fixed port instead of leaking EADDRINUSE", async () => {
    const first = await startHeadlessOAuthLoopback("state-a", {
      printUrl: () => undefined,
      timeoutMs: 500,
    });
    const port = Number(new URL(first.redirectUri).port);
    try {
      await expect(
        startHeadlessOAuthLoopback("state-b", {
          port,
          printUrl: () => undefined,
          timeoutMs: 500,
        }),
      ).rejects.toThrow(/端口 \d+ 被占用/);
    } finally {
      await first.close();
    }
  });

  it("hands the URL and tunnel to the caller instead of stdout", async () => {
    const lines: string[] = [];
    const seen: Array<{ url: string; tunnel: string | null }> = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    const loopback = await startHeadlessOAuthLoopback("expected-state", {
      port: 0,
      printUrl: (url) => lines.push(url),
      onAuthorizationUrl: (info) => seen.push(info),
      timeoutMs: 1_000,
    });
    try {
      const pending = capture(loopback.authorize("https://accounts.example/authorize"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      // 界面自己会展示，stdout 保持干净。
      expect(lines).toEqual([]);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toBe("https://accounts.example/authorize");
      expect(seen[0]?.tunnel).toContain("ssh -N -L");
      await loopback.close();
      await expect(pending).rejects.toThrow(/cancelled/);
    } finally {
      console.log = original;
      await loopback.close();
    }
  });
});
