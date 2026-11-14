import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";

import type { DeckHttpPort, HttpDeps } from "../../src/http/deps.js";
import { startDaemonHttp, type DaemonHttpServer } from "../../src/http/server.js";

async function withServer(run: (server: DaemonHttpServer, deleted: number[]) => Promise<void>, fail = false) {
  const dir = mkdtempSync(join(tmpdir(), "yb-tty7-delete-"));
  const deleted: number[] = [];
  const deck = {
    async tty7Delete(pane: number) {
      if (fail) throw new Error("synthetic close failure");
      deleted.push(pane);
      return { ok: true as const };
    },
  } as Pick<DeckHttpPort, "tty7Delete"> as DeckHttpPort;
  const server = await startDaemonHttp({ dataDir: dir, deps: { deck } as HttpDeps });
  try { await run(server, deleted); }
  finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
}

function remove(server: DaemonHttpServer, body: unknown, token = server.token) {
  return fetch(server.baseUrl + "/api/deck/tty7/delete", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

it("requires authentication before closing a session", async () => {
  await withServer(async (server, deleted) => {
    const response = await remove(server, { pane: 12 }, "invalid-test-token");
    expect(response.status).toBe(401);
    expect(deleted).toEqual([]);
  });
});

it("rejects missing, invalid and extra targets without deleting anything", async () => {
  await withServer(async (server, deleted) => {
    for (const body of [{}, { pane: -1 }, { pane: 1.5 }, { pane: "12" }, { pane: 12, all: true }]) {
      const response = await remove(server, body);
      expect(response.status).toBe(400);
    }
    const response = await fetch(server.baseUrl + "/api/deck/tty7/delete", {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(response.status).toBe(405);
    expect(deleted).toEqual([]);
  });
});

it("closes only the supplied pane and returns success", async () => {
  await withServer(async (server, deleted) => {
    const response = await remove(server, { pane: 12 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(deleted).toEqual([12]);
  });
});

it("reports a failed close instead of a successful deletion", async () => {
  await withServer(async (server, deleted) => {
    const response = await remove(server, { pane: 12 });
    expect(response.status).toBe(500);
    expect(deleted).toEqual([]);
  }, true);
});
