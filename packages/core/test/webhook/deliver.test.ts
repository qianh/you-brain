import { createHmac } from "node:crypto";

import type { Event } from "@you-brain/protocol";
import { describe, expect, test } from "bun:test";

import {
  emptyWebhookState,
  parseWebhookState,
  postWebhook,
  runWebhookDelivery,
  type WebhookConfig,
  type WebhookFetch,
  type WebhookState,
} from "../../src/webhook/index.js";
import { buildEvent } from "../topics/helpers.js";

const ENABLED_AT = "2026-10-18T02:00:00.000Z";
const SECRET = "top-secret";
const URL = "https://hooks.example/you-brain";
/** Backoff after attempts 1 through 5. Attempt 6 gives up. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];

function config(patch?: Partial<WebhookConfig>): WebhookConfig {
  return {
    enabled: true,
    url: URL,
    secret: SECRET,
    events: ["reminder.issued", "topic.created", "topic.status_changed", "topic.merged"],
    ...patch,
  };
}

function state(patch?: Partial<WebhookState>): WebhookState {
  return { ...emptyWebhookState(), enabledAt: ENABLED_AT, ...patch };
}

function reminder(idPart: string, ts: string, seq: number): Event {
  return buildEvent({
    type: "reminder.issued",
    data: {
      reminderId: `morning:${idPart}`,
      kind: "morning_digest",
      topicId: null,
      text: `hello ${idPart}`,
    },
    device: "device-1",
    ts,
    seq,
  });
}

interface Captured {
  url: string;
  body: string;
  redirect: string;
  headers: Headers;
}

function okFetch(calls: Captured[], status = 200): WebhookFetch {
  return (input, init) => {
    calls.push({
      url: String(input),
      body: String(init?.body ?? ""),
      redirect: init?.redirect,
      headers: new Headers(init?.headers),
    });
    return Promise.resolve(new Response("ok", { status }));
  };
}

describe("runWebhookDelivery", () => {
  test("marks successes delivered and keeps log order", async () => {
    const first = reminder("a", "2026-10-18T02:00:01.000Z", 1);
    const second = reminder("b", "2026-10-18T02:00:02.000Z", 2);
    const calls: Captured[] = [];
    const now = new Date("2026-10-18T02:00:10.000Z");
    const result = await runWebhookDelivery({
      events: [first, second],
      state: state(),
      now,
      config: config(),
      fetch: okFetch(calls),
    });
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.state.delivered).toEqual([first.id, second.id]);
    expect(calls.map((call) => (JSON.parse(call.body) as { id: string }).id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(calls[0]?.redirect).toBe("manual");
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const signature = createHmac("sha256", SECRET)
      .update(`${timestamp}.${calls[0]?.body ?? ""}`)
      .digest("hex");
    expect(calls[0]?.headers.get("x-youbrain-signature")).toBe(`v1=${signature}`);
    expect(calls[0]?.headers.get("x-youbrain-delivery")).toBe(first.id);
    expect(calls[0]?.headers.get("x-youbrain-event")).toBe("reminder.issued");
    expect(calls[0]?.headers.get("x-youbrain-timestamp")).toBe(timestamp);
  });

  test("stops the round on failure and waits 1m, 5m, 30m, 2h, then 6h", async () => {
    const stuck = reminder("stuck", "2026-10-18T02:00:01.000Z", 1);
    const later = reminder("later", "2026-10-18T02:00:02.000Z", 2);
    let calls = 0;
    const fetchImpl: WebhookFetch = () => {
      calls += 1;
      return Promise.resolve(new Response("no", { status: 500 }));
    };
    let current = state();
    let now = Date.parse("2026-10-18T03:00:00.000Z");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const before = calls;
      const result = await runWebhookDelivery({
        events: [stuck, later],
        state: current,
        now: new Date(now),
        config: config(),
        fetch: fetchImpl,
      });
      expect(calls).toBe(before + 1);
      expect(result.sent).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.state.delivered).toEqual([]);
      const pending = result.state.attempts[stuck.id];
      const wait = BACKOFF_MS[attempt];
      if (!pending || wait === undefined) throw new Error("missing backoff");
      expect(pending.count).toBe(attempt + 1);
      expect(Date.parse(pending.nextAt) - now).toBe(wait);
      const early = await runWebhookDelivery({
        events: [stuck, later],
        state: result.state,
        now: new Date(now + wait - 1),
        config: config(),
        fetch: fetchImpl,
      });
      expect(calls).toBe(before + 1);
      expect(early.failed).toBe(0);
      expect(early.sent).toBe(0);
      current = result.state;
      now += BACKOFF_MS[attempt] ?? 0;
    }
  });

  test("gives up on the 6th failure and continues with the next event", async () => {
    const stuck = reminder("stuck", "2026-10-18T02:00:01.000Z", 1);
    const later = reminder("later", "2026-10-18T02:00:02.000Z", 2);
    let calls = 0;
    const fetchImpl: WebhookFetch = () => {
      calls += 1;
      if (calls <= 6) return Promise.resolve(new Response("no", { status: 500 }));
      return Promise.resolve(new Response("ok", { status: 204 }));
    };
    let current = state();
    let now = Date.parse("2026-10-18T03:00:00.000Z");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await runWebhookDelivery({
        events: [stuck, later],
        state: current,
        now: new Date(now),
        config: config(),
        fetch: fetchImpl,
      });
      current = result.state;
      now += BACKOFF_MS[attempt] ?? 0;
    }
    const result = await runWebhookDelivery({
      events: [stuck, later],
      state: current,
      now: new Date(now),
      config: config(),
      fetch: fetchImpl,
    });
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.state.delivered).toEqual([stuck.id, later.id]);
    expect(result.state.attempts[stuck.id]).toBeUndefined();
    expect(result.state.last?.ok).toBe(true);
    expect(result.state.last?.eventId).toBe(later.id);
    expect(calls).toBe(7);
  });

  test("does not send events from before enabledAt", async () => {
    const early = reminder("early", "2026-10-18T01:59:59.999Z", 1);
    const due = reminder("due", ENABLED_AT, 2);
    const calls: Captured[] = [];
    const result = await runWebhookDelivery({
      events: [early, due],
      state: state(),
      now: new Date("2026-10-18T02:00:05.000Z"),
      config: config(),
      fetch: okFetch(calls),
    });
    expect(result.state.delivered).toEqual([due.id]);
    expect(calls).toHaveLength(1);
    const unset = await runWebhookDelivery({
      events: [due],
      state: state({ enabledAt: null }),
      now: new Date("2026-10-18T02:00:05.000Z"),
      config: config(),
      fetch: okFetch([]),
    });
    expect(unset.sent).toBe(0);
  });

  test("keeps the newest 2000 delivered ids", async () => {
    const fresh = reminder("fresh", "2026-10-18T02:00:01.000Z", 1);
    const delivered = Array.from({ length: 2000 }, (_, index) => `old-${index}`);
    const result = await runWebhookDelivery({
      events: [fresh],
      state: state({ delivered }),
      now: new Date("2026-10-18T02:00:05.000Z"),
      config: config(),
      fetch: okFetch([]),
    });
    expect(result.state.delivered).toHaveLength(2000);
    expect(result.state.delivered[0]).toBe("old-1");
    expect(result.state.delivered.at(-1)).toBe(fresh.id);
    expect(result.state.delivered).not.toContain("old-0");
  });

  test("treats a 3xx response as a failure", async () => {
    const event = reminder("redirect", "2026-10-18T02:00:01.000Z", 1);
    const result = await runWebhookDelivery({
      events: [event],
      state: state(),
      now: new Date("2026-10-18T02:00:05.000Z"),
      config: config(),
      fetch: okFetch([], 302),
    });
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.state.delivered).toEqual([]);
    expect(result.state.last?.status).toBe(302);
    expect(result.state.last?.error).toBe("hooks.example: HTTP 302");
  });

  test("redacts timeout and thrown errors", async () => {
    const event = reminder("secret", "2026-10-18T02:00:01.000Z", 1);
    const secret = "super-secret-value";
    const url = "https://hooks.example/hook?token=super-secret-value";
    const now = new Date("2026-10-18T02:00:05.000Z");
    const timeout = await runWebhookDelivery({
      events: [event],
      state: state(),
      now,
      config: config({ url, secret }),
      fetch: () =>
        Promise.reject(
          Object.assign(new Error(`timed out ${url} user:pass secret=${secret}`), { name: "TimeoutError" }),
        ),
    });
    expect(timeout.state.last?.error).toBe("hooks.example: 超时");
    expect(timeout.state.last?.error ?? "").not.toContain("super-secret-value");
    expect(timeout.state.last?.error ?? "").not.toContain("token");
    expect(timeout.state.last?.error ?? "").not.toContain("user:pass");

    const thrown = await postWebhook({
      url: "https://user:pass@hooks.example/hook?token=super-secret-value",
      secret,
      payload: {
        id: event.id,
        type: event.type,
        occurredAt: event.ts,
        deviceId: event.device,
        data: event.data,
      },
      fetch: () => Promise.reject(new Error(`connect failed ${url} user:pass secret=${secret}`)),
      now,
    });
    expect(thrown.ok).toBe(false);
    if (thrown.ok || thrown.reason === "aborted") throw new Error("expected a network error");
    expect(thrown.error).toBe("hooks.example: 连接失败");
    expect(thrown.error).not.toContain(secret);
    expect(thrown.error).not.toContain("token");
    expect(thrown.error).not.toContain("user:pass");
  });

  test("drops a stored error that still contains a URL", () => {
    const parsed = parseWebhookState(
      JSON.stringify({
        enabledAt: ENABLED_AT,
        delivered: [],
        attempts: {},
        last: {
          at: ENABLED_AT,
          ok: false,
          error: "failed https://user:pass@hooks.example/hook?token=super-secret-value",
        },
      }),
    );
    expect(parsed.last?.error).toBe("webhook: 连接失败");
  });
});
