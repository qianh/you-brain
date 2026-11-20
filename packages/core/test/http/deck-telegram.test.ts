import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";

import { YouBrainError } from "../../src/domain/errors.js";
import type { DeckHttpPort, HttpDeps } from "../../src/http/deps.js";
import type { DeckTelegramActionBody, DeckTelegramStatusResponse } from "../../src/http/types.js";
import { startDaemonHttp, type DaemonHttpServer } from "../../src/http/server.js";

const STATUS: DeckTelegramStatusResponse = {
  configured: true,
  bot: { username: "ub_bot", name: "UB" },
  connection: "ok",
  error: null,
  bound: null,
  pairing: null,
  relay: null,
  notificationsEnabled: false,
};

async function withServer(run: (server: DaemonHttpServer, actions: DeckTelegramActionBody[]) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "yb-deck-telegram-"));
  const actions: DeckTelegramActionBody[] = [];
  const deck = {
    async telegramStatus() {
      return STATUS;
    },
    async telegramAction(body: DeckTelegramActionBody) {
      actions.push(body);
      if (body.action === "test") throw new YouBrainError("INVALID_INPUT", "还没有绑定 Telegram");
      return STATUS;
    },
    async telegramInvite() {
      return { invite: "u-brain-relay:abc" };
    },
  } as Pick<DeckHttpPort, "telegramStatus" | "telegramAction" | "telegramInvite"> as DeckHttpPort;
  const server = await startDaemonHttp({ dataDir: dir, deps: { deck } as HttpDeps });
  try {
    await run(server, actions);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

function call(server: DaemonHttpServer, method: string, body?: unknown, path = "/api/deck/telegram") {
  return fetch(server.baseUrl + path, {
    method,
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

it("reads status and forwards validated actions", async () => {
  await withServer(async (server, actions) => {
    const status = await call(server, "GET");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual(STATUS);

    const pair = await call(server, "POST", { action: "pair" });
    expect(pair.status).toBe(200);
    expect(actions).toEqual([{ action: "pair" }]);

    expect((await call(server, "POST", { action: "set-token" })).status).toBe(400);
    expect((await call(server, "POST", { action: "rm -rf" })).status).toBe(400);
    expect((await call(server, "POST", { action: "set-notifications", enabled: "true" })).status).toBe(400);
    expect(actions).toHaveLength(1);

    const toggle = await call(server, "POST", { action: "set-notifications", enabled: true });
    expect(toggle.status).toBe(200);
    expect(actions.at(-1)).toEqual({ action: "set-notifications", enabled: true });

    const failed = await call(server, "POST", { action: "test" });
    expect(failed.status).toBe(400);
    expect(((await failed.json()) as { error: { message: string } }).error.message).toContain("还没有绑定");
  });
});

it("hands out the relay connection info only by POST", async () => {
  await withServer(async (server) => {
    const invite = await call(server, "POST", undefined, "/api/deck/telegram/invite");
    expect(invite.status).toBe(200);
    expect(await invite.json()).toEqual({ invite: "u-brain-relay:abc" });
    expect((await call(server, "GET", undefined, "/api/deck/telegram/invite")).status).toBe(405);
  });
});
