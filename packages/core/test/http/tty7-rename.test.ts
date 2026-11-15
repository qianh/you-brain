import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";

import type { DeckHttpPort, HttpDeps } from "../../src/http/deps.js";
import { startDaemonHttp, type DaemonHttpServer } from "../../src/http/server.js";

type Renamed = Array<{ pane: number; name: string }>;

async function withServer(run: (server: DaemonHttpServer, renamed: Renamed) => Promise<void>, fail = false) {
  const dir = mkdtempSync(join(tmpdir(), "yb-tty7-rename-"));
  const renamed: Renamed = [];
  const deck = {
    async tty7Rename(body: { pane: number; name: string }) {
      if (fail) throw new Error("synthetic rename failure");
      renamed.push(body);
      return { ok: true as const };
    },
  } as Pick<DeckHttpPort, "tty7Rename"> as DeckHttpPort;
  const server = await startDaemonHttp({ dataDir: dir, deps: { deck } as HttpDeps });
  try { await run(server, renamed); }
  finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
}

function rename(server: DaemonHttpServer, body: unknown) {
  return fetch(server.baseUrl + "/api/deck/tty7/rename", {
    method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

it("renames the session and trims the name", async () => {
  await withServer(async (server, renamed) => {
    const response = await rename(server, { pane: 7, name: "  账本 🧠  " });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(renamed).toEqual([{ pane: 7, name: "账本 🧠" }]);
  });
});

it("rejects blank, overlong and extra-field bodies", async () => {
  await withServer(async (server, renamed) => {
    for (const body of [
      { pane: 7, name: "   " },
      { pane: 7, name: "a".repeat(81) },
      { pane: 7, name: "x", extra: 1 },
      { pane: -1, name: "x" },
      { name: "x" },
    ]) {
      expect((await rename(server, body)).status).toBe(400);
    }
    expect((await rename(server, { pane: 7, name: "a".repeat(80) })).status).toBe(200);
    expect(renamed.length).toBe(1);
  });
});

it("reports a tty7 failure instead of success", async () => {
  await withServer(async (server) => {
    const response = await rename(server, { pane: 7, name: "x" });
    expect(response.status).not.toBe(200);
    expect(response.status).toBe(500);
  }, true);
});
