import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";

import type { DeckHttpPort, HttpDeps } from "../../src/http/deps.js";
import type { DeckNoticeDismissBody } from "../../src/http/types.js";
import { startDaemonHttp, type DaemonHttpServer } from "../../src/http/server.js";

async function withServer(
  run: (server: DaemonHttpServer, viewing: Array<number | null>, dismissed: DeckNoticeDismissBody[]) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "yb-deck-notices-"));
  const viewing: Array<number | null> = [];
  const dismissed: DeckNoticeDismissBody[] = [];
  const deck = {
    async notices() {
      return {
        epoch: "e1",
        latest: 2,
        notices: [
          {
            seq: 2,
            pane: 7,
            kind: "done" as const,
            status: "open" as const,
            sessionName: "账本",
            agent: "Claude",
            cwd: "/Users/x/ledger",
            title: "账本 已完成",
            body: "",
            at: "2026-11-16T00:00:00.000Z",
          },
        ],
      };
    },
    async noticeDismiss(body: DeckNoticeDismissBody) {
      dismissed.push(body);
      return { ok: true as const };
    },
    async tty7Viewing(body: { pane: number | null }) {
      viewing.push(body.pane);
      return { ok: true as const };
    },
  } as Pick<DeckHttpPort, "notices" | "noticeDismiss" | "tty7Viewing"> as DeckHttpPort;
  const server = await startDaemonHttp({ dataDir: dir, deps: { deck } as HttpDeps });
  try {
    await run(server, viewing, dismissed);
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
      notices: [
        {
          seq: 2,
          pane: 7,
          kind: "done",
          status: "open",
          sessionName: "账本",
          agent: "Claude",
          cwd: "/Users/x/ledger",
          title: "账本 已完成",
          body: "",
          at: "2026-11-16T00:00:00.000Z",
        },
      ],
    });
  });
});

it("dismisses notices by seq or pane and rejects invalid bodies", async () => {
  await withServer(async (server, _viewing, dismissed) => {
    const unauth = await fetch(server.baseUrl + "/api/deck/notices/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq: 2 }),
    });
    expect(unauth.status).toBe(401);

    for (const body of [{ seq: 2 }, { pane: 7 }, { seq: 2, pane: 7 }]) {
      const response = await fetch(server.baseUrl + "/api/deck/notices/dismiss", {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
    expect(dismissed).toEqual([{ seq: 2 }, { pane: 7 }, { seq: 2, pane: 7 }]);

    for (const bad of [{}, { seq: 0 }, { seq: -1 }, { pane: -1 }, { seq: 2, extra: true }]) {
      const response = await fetch(server.baseUrl + "/api/deck/notices/dismiss", {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify(bad),
      });
      expect(response.status).toBe(400);
    }
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
