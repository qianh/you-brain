import { createHmac } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { ManualDaemonClock } from "../../src/daemon/clock.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { foldEvents, persistTopicBook } from "../../src/topics/index.js";
import { webhookConfigPath, writeWebhookConfig, type WebhookConfig } from "../../src/webhook/config.js";
import type { WebhookFetch } from "../../src/webhook/deliver.js";
import {
  CLOCK_START,
  makeDaemonDirs,
  throwingEmbedder,
  type DaemonDirs,
} from "../daemon/helpers.js";
import { buildEvent } from "../topics/helpers.js";

const URL = "https://hooks.example/hook?token=super-secret";
const SECRET = "top-secret";

interface Captured {
  body: string;
  redirect: string;
  headers: Headers;
}

function daemonOptions(dirs: DaemonDirs, clock: ManualDaemonClock, webhookFetch: WebhookFetch) {
  return {
    homeDir: dirs.homeDir,
    platform: "darwin" as const,
    env: dirs.env,
    hostname: "webhook-device",
    clock,
    drive: null,
    llm: null,
    embedder: throwingEmbedder,
    sourceRoots: {},
    watch: false,
    signals: false,
    webhookFetch,
  };
}

async function api(daemon: YouBrainDaemon, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${daemon.token}`);
  const response = await fetch(`${daemon.baseUrl}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`${path} ${response.status} ${await response.text()}`);
  return response;
}

async function rememberMain(daemon: YouBrainDaemon): Promise<void> {
  const status = (await (await api(daemon, "/api/status")).json()) as { deviceId: string };
  await api(daemon, "/api/roles", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainDevice: status.deviceId }),
  });
}

async function enableFile(dirs: DaemonDirs): Promise<void> {
  const stored: WebhookConfig = {
    enabled: true,
    url: URL,
    secret: SECRET,
    events: ["reminder.issued", "topic.created", "topic.status_changed", "topic.merged"],
  };
  await writeWebhookConfig(webhookConfigPath(dirs.dataDir), stored);
}

function okFetch(calls: Captured[]): WebhookFetch {
  return (_input, init) => {
    calls.push({
      body: String(init?.body ?? ""),
      redirect: init?.redirect,
      headers: new Headers(init?.headers),
    });
    return Promise.resolve(new Response("ok", { status: 200 }));
  };
}

function statusFetch(calls: Captured[], status: number): WebhookFetch {
  return (_input, init) => {
    calls.push({
      body: String(init?.body ?? ""),
      redirect: init?.redirect,
      headers: new Headers(init?.headers),
    });
    return Promise.resolve(new Response("no", { status }));
  };
}

function hangFetch(calls: Captured[]): WebhookFetch {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      calls.push({
        body: String(init?.body ?? ""),
        redirect: init?.redirect,
        headers: new Headers(init?.headers),
      });
      const signal = init?.signal;
      const fail = (): void => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      };
      if (!signal || signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener("abort", fail, { once: true });
    });
}

async function waitUntil(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 5_000) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("webhook daemon delivery", () => {
  test("the main device signs reminder.issued; another device does not send", async () => {
    const dirs = await makeDaemonDirs("you-brain-webhook-daemon-");
    const clock = new ManualDaemonClock(CLOCK_START);
    const calls: Captured[] = [];
    const first = await startDaemon(daemonOptions(dirs, clock, okFetch(calls)));
    try {
      await first.settled();
      await rememberMain(first);
    } finally {
      await first.stop();
    }
    await enableFile(dirs);
    const second = await startDaemon(daemonOptions(dirs, clock, okFetch(calls)));
    try {
      await second.settled();
      await clock.advance(3_000);
      expect(calls.length).toBeGreaterThan(0);
      const payload = JSON.parse(calls[0]?.body ?? "") as {
        id: string;
        type: string;
        data: { reminderId: string; kind: string; text: string };
      };
      expect(payload.type).toBe("reminder.issued");
      expect(payload.data.reminderId.length).toBeGreaterThan(0);
      expect(payload.data.kind.length).toBeGreaterThan(0);
      expect(payload.data.text.length).toBeGreaterThan(0);
      expect(calls[0]?.redirect).toBe("manual");
      const timestamp = calls[0]?.headers.get("x-youbrain-timestamp") ?? "";
      const signature = createHmac("sha256", SECRET)
        .update(`${timestamp}.${calls[0]?.body ?? ""}`)
        .digest("hex");
      expect(calls[0]?.headers.get("x-youbrain-signature")).toBe(`v1=${signature}`);
      expect(calls[0]?.headers.get("x-youbrain-delivery")).toBe(payload.id);
      expect(calls[0]?.headers.get("x-youbrain-event")).toBe("reminder.issued");
      const view = (await (await api(second, "/api/webhook")).json()) as Record<string, unknown>;
      expect(view.active).toBe(true);
      expect(view).not.toHaveProperty("secret");
      expect(JSON.stringify(view)).not.toContain(SECRET);
      expect(JSON.stringify(view.last)).not.toContain("token=");
    } finally {
      await second.stop();
      await rm(dirs.root, { recursive: true, force: true });
    }

    const otherDirs = await makeDaemonDirs("you-brain-webhook-other-");
    const otherClock = new ManualDaemonClock(CLOCK_START);
    const otherCalls: Captured[] = [];
    const other = await startDaemon(daemonOptions(otherDirs, otherClock, okFetch(otherCalls)));
    try {
      await other.settled();
    } finally {
      await other.stop();
    }
    await enableFile(otherDirs);
    const store = new SqliteStore(join(otherDirs.dataDir, "state.sqlite"));
    try {
      persistTopicBook(
        store,
        foldEvents([
          buildEvent({
            type: "topic.created",
            data: { topicId: "topic-park", name: "停车", aliases: [] },
            device: "dev-a",
            ts: "2026-10-01T00:00:00.000Z",
            seq: 1,
          }),
          buildEvent({
            type: "topic.status_changed",
            data: { topicId: "topic-park", status: "parked", by: "user" },
            device: "dev-a",
            ts: CLOCK_START.toISOString(),
            seq: 2,
          }),
        ]),
      );
    } finally {
      store.close();
    }
    const parked = await startDaemon(daemonOptions(otherDirs, otherClock, okFetch(otherCalls)));
    try {
      await parked.settled();
      await otherClock.advance(3_000);
      expect(otherCalls).toHaveLength(0);
      const view = (await (await api(parked, "/api/webhook")).json()) as { active: boolean; pending: number };
      expect(view.active).toBe(false);
      expect(view.pending).toBe(1);
    } finally {
      await parked.stop();
      await rm(otherDirs.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("retries after the clock passes the backoff, and stops sending after shutdown", async () => {
    const dirs = await makeDaemonDirs("you-brain-webhook-retry-");
    const clock = new ManualDaemonClock(CLOCK_START);
    const calls: Captured[] = [];
    const first = await startDaemon(daemonOptions(dirs, clock, statusFetch(calls, 500)));
    try {
      await first.settled();
      await rememberMain(first);
    } finally {
      await first.stop();
    }
    await enableFile(dirs);
    const daemon = await startDaemon(daemonOptions(dirs, clock, statusFetch(calls, 500)));
    try {
      await daemon.settled();
      await clock.advance(1_500);
      expect(calls).toHaveLength(1);
      const delivery = calls[0]?.headers.get("x-youbrain-delivery");
      await clock.advance(2_000);
      expect(calls).toHaveLength(1);
      await clock.advance(70_000);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.headers.get("x-youbrain-delivery")).toBe(delivery);
      const view = (await (await api(daemon, "/api/webhook")).json()) as {
        last: { ok: boolean; status?: number; error?: string } | null;
      };
      expect(view.last?.ok).toBe(false);
      expect(view.last?.status).toBe(500);
      expect(view.last?.error).toBe("hooks.example: HTTP 500");
      expect(view.last?.error ?? "").not.toContain("token");
      expect(view.last?.error ?? "").not.toContain(SECRET);
    } finally {
      await daemon.stop();
      await rm(dirs.root, { recursive: true, force: true });
    }

    const stopDirs = await makeDaemonDirs("you-brain-webhook-stop-");
    const stopClock = new ManualDaemonClock(CLOCK_START);
    const stopCalls: Captured[] = [];
    const primed = await startDaemon(daemonOptions(stopDirs, stopClock, hangFetch(stopCalls)));
    try {
      await primed.settled();
      await rememberMain(primed);
    } finally {
      await primed.stop();
    }
    await enableFile(stopDirs);
    const stopping = await startDaemon(daemonOptions(stopDirs, stopClock, hangFetch(stopCalls)));
    await stopping.settled();
    const advanced = stopClock.advance(1_500);
    try {
      await waitUntil(() => stopCalls.length > 0);
      await stopping.stop();
      await advanced;
      const sent = stopCalls.length;
      await stopClock.advance(120_000);
      expect(stopCalls).toHaveLength(sent);
    } finally {
      await rm(stopDirs.root, { recursive: true, force: true });
    }
  }, 30_000);
});
