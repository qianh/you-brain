import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import type { HttpDeps } from "../../src/http/deps.js";
import { startDaemonHttp, type DaemonHttpServer } from "../../src/http/server.js";

const SHELL = "<!doctype html><html><head><title>T3 Code (Alpha)</title></head><body></body></html>";

async function withServers(run: (server: DaemonHttpServer, url: string, requests: Request[]) => Promise<void>,
  respond: (request: Request) => Response = () => new Response(SHELL, { headers: { "content-type": "text/html" } }),
) {
  const dir = mkdtempSync(join(tmpdir(), "yb-t3-probe-"));
  const requests: Request[] = [];
  const t3 = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) { requests.push(request); return respond(request); },
  });
  const server = await startDaemonHttp({ dataDir: dir, deps: {} as HttpDeps });
  try { await run(server, `http://127.0.0.1:${t3.port}/`, requests); }
  finally { await server.stop(); await t3.stop(true); rmSync(dir, { recursive: true, force: true }); }
}

function probe(server: DaemonHttpServer, url: string, token = server.token, method = "GET") {
  return fetch(`${server.baseUrl}/api/deck/t3?url=${encodeURIComponent(url)}`, {
    method,
    headers: { authorization: `Bearer ${token}`, cookie: "synthetic-daemon-cookie=private" },
  });
}

test("checks authentication and method before contacting T3", async () => {
  await withServers(async (server, url, requests) => {
    expect((await probe(server, url, "invalid-test-token")).status).toBe(401);
    expect((await probe(server, url, server.token, "POST")).status).toBe(405);
    expect(requests).toHaveLength(0);
  });
});

test("validates the address independently of the web UI", async () => {
  await withServers(async (server, url, requests) => {
    for (const invalid of ["", "https://example.com/", `${url}?token=synthetic-token`, `${url}thread/1`, url.replace("http://", "http://user:password@")]) {
      expect((await probe(server, invalid)).status).toBe(400);
    }
    expect(requests).toHaveLength(0);
  });
});

test("returns the T3 shell URL without forwarding daemon authentication or cookies", async () => {
  await withServers(async (server, url, requests) => {
    const response = await probe(server, url.slice(0, -1));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "ready", url });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.has("authorization")).toBe(false);
    expect(requests[0]?.headers.has("cookie")).toBe(false);
  });
});

test("rejects a different service on the chosen port", async () => {
  await withServers(async (server, url) => {
    expect(await (await probe(server, url)).json()).toEqual({ state: "error", url, reason: "not-t3" });
  }, () => new Response("<title>Other local app</title>", { headers: { "content-type": "text/html" } }));
});

test("does not follow a redirect to another endpoint", async () => {
  await withServers(async (server, url, requests) => {
    expect(await (await probe(server, url)).json()).toEqual({ state: "error", url, reason: "unavailable" });
    expect(requests).toHaveLength(1);
  }, (request) => new Response(null, { status: 302, headers: { location: new URL("/redirect-target", request.url).href } }));
});

test("reports a stopped server as unavailable", async () => {
  await withServers(async (server) => {
    const stopped = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(SHELL) });
    const url = `http://127.0.0.1:${stopped.port}/`;
    await stopped.stop(true);
    expect(await (await probe(server, url)).json()).toEqual({ state: "error", url, reason: "unavailable" });
  });
});

test("reports an explicit embedding restriction", async () => {
  await withServers(async (server, url) => {
    expect(await (await probe(server, url)).json()).toEqual({ state: "error", url, reason: "frame-blocked" });
  }, () => new Response(SHELL, { headers: { "content-type": "text/html", "x-frame-options": "SAMEORIGIN" } }));
});

test("allows a T3 shell that permits this daemon origin", async () => {
  await withServers(async (server, url) => {
    expect(await (await probe(server, url)).json()).toEqual({ state: "ready", url });
  }, () => new Response(SHELL, { headers: { "content-type": "text/html", "content-security-policy": "frame-ancestors 'self' http://127.0.0.1:3921" } }));
});

test("does not scan an unbounded response for a T3 title", async () => {
  await withServers(async (server, url) => {
    expect(await (await probe(server, url)).json()).toEqual({ state: "error", url, reason: "not-t3" });
  }, () => new Response(" ".repeat(70 * 1024) + SHELL, { headers: { "content-type": "text/html" } }));
});
