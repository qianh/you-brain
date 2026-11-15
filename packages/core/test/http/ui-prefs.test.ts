import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";

import type { HttpDeps } from "../../src/http/deps.js";
import { startDaemonHttp, type DaemonHttpServer } from "../../src/http/server.js";
import { UiPrefsStore } from "../../src/ui-prefs/store.js";

async function withServer(run: (server: DaemonHttpServer, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "yb-ui-prefs-http-"));
  const staticDir = join(dir, "web");
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, "index.html"), '<!doctype html><html><head><script id="own"></script></head><body></body></html>');
  const uiPrefs = new UiPrefsStore(join(dir, "ui-prefs.json"));
  const server = await startDaemonHttp({ dataDir: dir, staticDir, deps: { uiPrefs } as unknown as HttpDeps });
  try { await run(server, dir); }
  finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
}

function call(server: DaemonHttpServer, method: "GET" | "PUT", body?: unknown, token: string | null = server.token) {
  return fetch(server.baseUrl + "/api/ui-prefs", {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

it("GET 返回当前偏好", async () => {
  await withServer(async (server) => {
    const response = await call(server, "GET");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ prefs: {} });
  });
});

it("PUT 合并并返回合并后的结果", async () => {
  await withServer(async (server) => {
    const response = await call(server, "PUT", { set: { a: "1" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ prefs: { a: "1" } });
    const merged = await call(server, "PUT", { set: { b: "2" }, remove: ["a"] });
    expect(await merged.json()).toEqual({ prefs: { b: "2" } });
    expect(await (await call(server, "GET")).json()).toEqual({ prefs: { b: "2" } });
  });
});

it("没有令牌返回 401", async () => {
  await withServer(async (server) => {
    expect((await call(server, "GET", undefined, null)).status).toBe(401);
    expect((await call(server, "PUT", { set: { a: "1" } }, null)).status).toBe(401);
    expect(await (await call(server, "GET")).json()).toEqual({ prefs: {} });
  });
});

it("超限返回 413 PAYLOAD_TOO_LARGE", async () => {
  await withServer(async (server) => {
    const response = await call(server, "PUT", { set: { big: "x".repeat(65537) } });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

it("请求体含未知字段返回 400", async () => {
  await withServer(async (server) => {
    expect((await call(server, "PUT", { set: { a: "1" }, extra: true })).status).toBe(400);
    expect(await (await call(server, "GET")).json()).toEqual({ prefs: {} });
  });
});

it("首页在 <head> 之后立刻注入令牌和偏好，且早于页面自带脚本", async () => {
  await withServer(async (server) => {
    await call(server, "PUT", { set: { k: "</script><b>" } });
    const html = await (await fetch(server.baseUrl + "/")).text();
    const injected = html.indexOf("window.__YOU_BRAIN__=");
    expect(injected).toBeGreaterThan(html.indexOf("<head>"));
    expect(injected).toBeLessThan(html.indexOf('id="own"'));
    expect(html).not.toContain("</script><b>");
    const match = /window\.__YOU_BRAIN__=(.*?)<\/script>/u.exec(html);
    const value = JSON.parse(match![1]!) as { token: string; prefs: Record<string, string> };
    expect(value.token).toBe(server.token);
    expect(value.prefs.k).toBe("</script><b>");
  });
});
