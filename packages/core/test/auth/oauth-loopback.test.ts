import { describe, expect, it } from "bun:test";

import { startOAuthLoopback } from "../../src/auth/oauth-loopback.js";

/** Attach a handler immediately so a later rejection is not unhandled. */
function capture(promise: Promise<string>): Promise<string> {
  const captured = promise.then(
    (value) => value,
    (error: unknown) => Promise.reject(error),
  );
  // Keep the derived promise observed until the test asserts on it.
  captured.catch(() => undefined);
  return promise;
}

describe("OAuth loopback callback", () => {
  it("rejects an invalid state without yielding a code", async () => {
    const loopback = await startOAuthLoopback("expected-state", {
      openUrl: async () => undefined,
      printUrl: () => undefined,
      timeoutMs: 1_000,
    });
    try {
      // Bun's expect().rejects waits before returning, so capture the
      // rejection ourselves and only assert after the callback arrives.
      const pending = capture(loopback.authorize("https://accounts.example/authorize"));
      const response = await fetch(
        `${loopback.redirectUri}?state=wrong-state&code=must-not-return`,
      );
      expect(response.status).toBe(400);
      await expect(pending).rejects.toThrow(/validation failed/);
    } finally {
      await loopback.close();
    }
  });

  it("rejects cancellation and still prints the URL when the browser fails", async () => {
    const printed: string[] = [];
    const loopback = await startOAuthLoopback("expected-state", {
      openUrl: async () => {
        throw new Error("spawn xdg-open ENOENT");
      },
      printUrl: (url) => printed.push(url),
      timeoutMs: 1_000,
    });
    try {
      const pending = capture(loopback.authorize("https://accounts.example/authorize"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(printed).toEqual(["https://accounts.example/authorize"]);
      const cancelled = await fetch(
        `${loopback.redirectUri}?state=expected-state&error=access_denied`,
      );
      expect(cancelled.status).toBe(400);
      await expect(pending).rejects.toThrow(/cancelled/);
    } finally {
      await loopback.close();
    }
  });

  it("prints a copyable authorization URL when the browser is not given a printer", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((item) => String(item)).join(" "));
    };
    const loopback = await startOAuthLoopback("expected-state", {
      openUrl: async () => undefined,
      timeoutMs: 1_000,
    });
    try {
      const pending = capture(
        loopback.authorize("https://accounts.example/authorize?client_id=abc&scope=drive"),
      );
      expect(lines.join("\n")).toContain("浏览器如果没有自动打开，请复制此链接完成授权：");
      expect(lines.join("\n")).toContain(
        "https://accounts.example/authorize?client_id=abc&scope=drive",
      );
      const cancelled = await fetch(
        `${loopback.redirectUri}?state=expected-state&error=access_denied`,
      );
      expect(cancelled.status).toBe(400);
      await expect(pending).rejects.toThrow(/cancelled/);
    } finally {
      console.log = original;
      await loopback.close();
    }
  });
});
