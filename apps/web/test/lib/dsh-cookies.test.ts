import { describe, expect, test } from "bun:test";

import { createDshCookiePreparer } from "../../src/lib/dsh-cookies.js";

describe("dsh cookie preparation", () => {
  test("keeps the cookie derived from the active authority, without passing the login token", async () => {
    const calls: unknown[] = [];
    const prepare = createDshCookiePreparer(async (command, args) => { calls.push({ command, args }); });
    await prepare("http://127.0.0.1:3001/?token=synthetic-login-token");
    await prepare("http://127.0.0.1:3001/?token=another-synthetic-token");
    await prepare("http://127.0.0.1:3002/?token=synthetic-login-token");

    expect(calls).toEqual([
      { command: "prepare_dsh_cookies", args: { keepCookieName: "dsh-auth-K2_yZnNhxchmA3xBCHa3jRo6zUNUS5gQjCZTvi-Pa-M" } },
      { command: "prepare_dsh_cookies", args: { keepCookieName: "dsh-auth-md4WdQRjn07I6_0NQvu34A33_UilnAYDLrVPf2yd0gw" } },
    ]);
  });

  test("waits for native cleanup, coalesces polls and retries failed cleanup", async () => {
    let release!: () => void;
    let calls = 0;
    const prepare = createDshCookiePreparer(async () => {
      calls += 1;
      if (calls === 1) throw new Error("synthetic cleanup failure");
      await new Promise<void>((resolve) => { release = resolve; });
    });
    const url = "http://127.0.0.1:3001/";
    await expect(prepare(url)).rejects.toThrow("synthetic cleanup failure");
    let finished = false;
    const retry = prepare(url).then(() => { finished = true; });
    const poll = prepare(url);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    expect(calls).toBe(2);
    release();
    await Promise.all([retry, poll]);
    expect(finished).toBe(true);
    await prepare(url);
    expect(calls).toBe(2);
  });

  test("ordinary browsers work without a native bridge", async () => {
    await createDshCookiePreparer(undefined)("http://127.0.0.1:3001/");
  });

  test("does not prune for a non-loopback dsh URL", async () => {
    let called = false;
    const prepare = createDshCookiePreparer(async () => { called = true; });
    await expect(prepare("https://example.com/")).rejects.toThrow("无效的 dsh 本地地址");
    expect(called).toBe(false);
  });
});
