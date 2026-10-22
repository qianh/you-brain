import { createHmac } from "node:crypto";
import { rm } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { WEBHOOK_EVENT_KINDS } from "../../src/webhook/kinds.js";
import type { WebhookFetch } from "../../src/webhook/deliver.js";
import {
  CLOCK_START,
  makeDaemonDirs,
  testClock,
  throwingEmbedder,
  type DaemonDirs,
} from "../daemon/helpers.js";

const URL = "https://hooks.example/you-brain?token=should-not-leak";
const SECRET = "alpha-secret";

interface Captured {
  body: string;
  redirect: string;
  headers: Headers;
}

async function boot(fetchImpl: WebhookFetch): Promise<{ daemon: YouBrainDaemon; dirs: DaemonDirs }> {
  const dirs = await makeDaemonDirs("you-brain-webhook-http-");
  const daemon = await startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname: "webhook-http",
    clock: testClock(),
    drive: null,
    llm: null,
    embedder: throwingEmbedder,
    sourceRoots: {},
    watch: false,
    signals: false,
    webhookFetch: fetchImpl,
  });
  return { daemon, dirs };
}

function api(daemon: YouBrainDaemon, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${daemon.token}`);
  return fetch(`${daemon.baseUrl}${path}`, { ...init, headers });
}

function jsonCall(daemon: YouBrainDaemon, path: string, method: string, body?: unknown): Promise<Response> {
  return api(daemon, path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("webhook HTTP", () => {
  test("GET hides the secret, PUT keeps or clears it, and test uses the injected fetch", async () => {
    const calls: Captured[] = [];
    const fetchImpl: WebhookFetch = (_input, init) => {
      calls.push({
        body: String(init?.body ?? ""),
        redirect: init?.redirect,
        headers: new Headers(init?.headers),
      });
      return Promise.resolve(new Response("ok", { status: 204 }));
    };
    const { daemon, dirs } = await boot(fetchImpl);
    try {
      const initial = (await (await api(daemon, "/api/webhook")).json()) as Record<string, unknown>;
      expect(initial).toEqual({
        enabled: false,
        url: "",
        hasSecret: false,
        events: [...WEBHOOK_EVENT_KINDS],
        active: false,
        last: null,
        pending: 0,
      });
      expect(initial).not.toHaveProperty("secret");

      const missing = await jsonCall(daemon, "/api/actions/webhook-test", "POST", {});
      expect(missing.status).toBe(400);

      const bad = await jsonCall(daemon, "/api/webhook", "PUT", {
        enabled: true,
        url: "https://user:pass@hooks.example/hook",
      });
      expect(bad.status).toBe(400);
      expect(await bad.text()).not.toContain("user:pass");

      const created = await jsonCall(daemon, "/api/webhook", "PUT", {
        enabled: true,
        url: URL,
        secret: SECRET,
      });
      expect(created.status).toBe(200);
      const createdBody = (await created.json()) as Record<string, unknown>;
      expect(createdBody.hasSecret).toBe(true);
      expect(createdBody.active).toBe(false);
      expect(JSON.stringify(createdBody)).not.toContain(SECRET);

      const kept = await jsonCall(daemon, "/api/webhook", "PUT", { url: URL });
      expect(kept.status).toBe(200);
      expect(((await kept.json()) as { hasSecret: boolean }).hasSecret).toBe(true);

      const disabled = await jsonCall(daemon, "/api/webhook", "PUT", { enabled: false });
      expect(disabled.status).toBe(200);
      const tested = await jsonCall(daemon, "/api/actions/webhook-test", "POST", {});
      expect(tested.status).toBe(200);
      expect(await tested.json()).toEqual({ ok: true, status: 204 });
      expect(calls).toHaveLength(1);
      const payload = JSON.parse(calls[0]?.body ?? "") as {
        id: string;
        type: string;
        occurredAt: string;
        deviceId: string;
        data: unknown;
      };
      expect(payload.type).toBe("webhook.test");
      expect(payload.id.startsWith("test-")).toBe(true);
      expect(payload.data).toEqual({});
      expect(payload.occurredAt).toBe(CLOCK_START.toISOString());
      expect(calls[0]?.redirect).toBe("manual");
      const timestamp = calls[0]?.headers.get("x-youbrain-timestamp") ?? "";
      const expected = createHmac("sha256", SECRET)
        .update(`${timestamp}.${calls[0]?.body ?? ""}`)
        .digest("hex");
      expect(calls[0]?.headers.get("x-youbrain-signature")).toBe(`v1=${expected}`);
      expect(calls[0]?.headers.get("x-youbrain-delivery")).toBe(payload.id);

      const cleared = await jsonCall(daemon, "/api/webhook", "PUT", { secret: "" });
      expect(((await cleared.json()) as { hasSecret: boolean }).hasSecret).toBe(false);
      calls.length = 0;
      const unsigned = await jsonCall(daemon, "/api/actions/webhook-test", "POST", {});
      expect(unsigned.status).toBe(200);
      expect(calls[0]?.headers.get("x-youbrain-signature")).toBeNull();

      const replaced = await jsonCall(daemon, "/api/webhook", "PUT", { secret: "beta-secret" });
      expect(((await replaced.json()) as { hasSecret: boolean }).hasSecret).toBe(true);
      calls.length = 0;
      expect((await jsonCall(daemon, "/api/actions/webhook-test", "POST", {})).status).toBe(200);
      const nextStamp = calls[0]?.headers.get("x-youbrain-timestamp") ?? "";
      const beta = createHmac("sha256", "beta-secret")
        .update(`${nextStamp}.${calls[0]?.body ?? ""}`)
        .digest("hex");
      expect(calls[0]?.headers.get("x-youbrain-signature")).toBe(`v1=${beta}`);

      const status = (await (await api(daemon, "/api/status")).json()) as { deviceId: string };
      const roles = await jsonCall(daemon, "/api/roles", "PUT", { mainDevice: status.deviceId });
      expect(roles.status).toBe(200);
      const active = (await (await api(daemon, "/api/webhook")).json()) as { active: boolean; enabled: boolean };
      expect(active.enabled).toBe(false);
      expect(active.active).toBe(false);
      const enabled = await jsonCall(daemon, "/api/webhook", "PUT", { enabled: true });
      expect(((await enabled.json()) as { active: boolean }).active).toBe(true);

      expect((await api(daemon, "/api/webhook", { method: "POST" })).status).toBe(405);
      expect((await api(daemon, "/api/actions/webhook-test")).status).toBe(405);
    } finally {
      await daemon.stop();
      await rm(dirs.root, { recursive: true, force: true });
    }
  }, 20_000);
});
