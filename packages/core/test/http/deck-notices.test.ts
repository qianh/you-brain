import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";

import type { DeckHttpPort, HttpDeps } from "../../src/http/deps.js";
import { startDaemonHttp, type DaemonHttpServer } from "../../src/http/server.js";

async function withServer(run: (server: DaemonHttpServer, viewing: Array<number | null>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "yb-deck-notices-"));
  const viewing: Array<number | null> = [];
  const deck = {
    async notices() {
      return {
        epoch: "e1",
        latest: 2,
        notices: [{ seq: 2, pane: 7, kind: "done" as const, title: "账本 已完成", body: "", at: "2026-11-16T00:00:00.000Z" }],
      };
    },
    async tty7Viewing(body: { pane: number | null }) {
      viewing.push(body.pane);
      return { ok: true as const };
    },
  } as Pick<DeckHttpPort, "notices" | "tty7Viewing"> as DeckHttpPort;
  const server = await startDaemonHttp({ dataDir: dir, deps: { deck } as HttpDeps });
  try {
    await run(server, viewing);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

function post(server: DaemonHttpServer, body: unknown, token = server.token) {
  return fetch(server.baseUrl + "/api/deck/tty7/viewing", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

it("returns the notice list with epoch, latest and entries", async () => {
  await withServer(async (server) => {
    const response = await fetch(server.baseUrl + "/api/deck/notices", { headers: { authorization: `Bearer ${server.token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      epoch: "e1",
      latest: 2,
      notices: [{ seq: 2, pane: 7, kind: "done", title: "账本 已完成", body: "", at: "2026-11-16T00:00:00.000Z" }],
    });
  });
});

it("requires authentication for both endpoints", async () => {
  await withServer(async (server, viewing) => {
    expect((await fetch(server.baseUrl + "/api/deck/notices")).status).toBe(401);
    expect((await post(server, { pane: 3 }, "invalid-test-token")).status).toBe(401);
    expect(viewing).toEqual([]);
  });
});

it("accepts a pane number or null for the viewed session", async () => {
  await withServer(async (server, viewing) => {
    for (const body of [{ pane: 3 }, { pane: null }]) {
      const response = await post(server, body);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
    expect(viewing).toEqual([3, null]);
  });
});

it("rejects extra fields, bad panes and wrong methods", async () => {
  await withServer(async (server, viewing) => {
    for (const body of [{}, { pane: -1 }, { pane: 1.5 }, { pane: "3" }, { pane: 3, all: true }]) {
      expect((await post(server, body)).status).toBe(400);
    }
    const response = await fetch(server.baseUrl + "/api/deck/tty7/viewing", { headers: { authorization: `Bearer ${server.token}` } });
    expect(response.status).toBe(405);
    expect(viewing).toEqual([]);
  });
});
