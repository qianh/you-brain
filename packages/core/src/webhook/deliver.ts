import type { Event } from "@you-brain/protocol";

import type { WebhookConfig } from "./config.js";
import { webhookUrlProblem } from "./config.js";
import type { WebhookEventKind } from "./kinds.js";
import { encodeWebhookBody, eventToPayload, type WebhookPayload } from "./payload.js";
import { webhookHeaders } from "./sign.js";

/** Cursor key for `{ enabledAt, delivered, attempts, last }`. */
export const WEBHOOK_STATE_CURSOR = "webhook.state";

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_ATTEMPTS = 6;
export const WEBHOOK_DELIVERED_CAP = 2_000;

/** After attempt 1..5. Attempt 6 gives up instead of waiting again. */
export const WEBHOOK_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
] as const;

export interface WebhookAttempt {
  count: number;
  nextAt: string;
}

export interface WebhookLast {
  at: string;
  ok: boolean;
  status?: number;
  error?: string;
  eventId?: string;
}

export interface WebhookState {
  enabledAt: string | null;
  delivered: string[];
  attempts: Record<string, WebhookAttempt>;
  last: WebhookLast | null;
}

export interface WebhookDeliveryResult {
  state: WebhookState;
  sent: number;
  failed: number;
}

export interface WebhookRequestInit {
  method: "POST";
  headers: Headers;
  body: string;
  redirect: "manual";
  signal: AbortSignal;
}

/** Injectable HTTP call. Narrower than `typeof fetch` so tests do not need Bun's `preconnect`. */
export type WebhookFetch = (url: string, init: WebhookRequestInit) => Promise<Response>;

export type WebhookPostResult =
  | { ok: true; status: number }
  | { ok: false; reason: "aborted" }
  | { ok: false; reason: "http"; status: number; error: string }
  | { ok: false; reason: "timeout"; error: string }
  | { ok: false; reason: "network"; error: string };

export function emptyWebhookState(): WebhookState {
  return { enabledAt: null, delivered: [], attempts: {}, last: null };
}

export function parseWebhookState(raw: string | null): WebhookState {
  if (raw === null || raw.trim() === "") return emptyWebhookState();
  try {
    return coerceWebhookState(JSON.parse(raw) as unknown);
  } catch {
    return emptyWebhookState();
  }
}

export function serializeWebhookState(state: WebhookState): string {
  return JSON.stringify({
    enabledAt: state.enabledAt,
    delivered: state.delivered.slice(-WEBHOOK_DELIVERED_CAP),
    attempts: state.attempts,
    last: state.last === null ? null : compactLast(state.last),
  });
}

/** Host only. Query, userinfo, path, and the secret never appear. */
export function webhookErrorHost(url: string): string {
  try {
    const host = new URL(url).host;
    return host === "" ? "webhook" : host;
  } catch {
    return "webhook";
  }
}

export function countWebhookPending(
  events: readonly Event[],
  state: WebhookState,
  kinds: readonly WebhookEventKind[],
): number {
  return selectCandidates(events, state, kinds).length;
}

/**
 * Send due events in log order. One failure stops the round so later events
 * wait. The 6th failure for an event is recorded and skipped so the queue moves.
 */
export async function runWebhookDelivery(input: {
  events: readonly Event[];
  state: WebhookState;
  now: Date;
  config: WebhookConfig;
  fetch: WebhookFetch;
  signal?: AbortSignal;
}): Promise<WebhookDeliveryResult> {
  const state = cloneState(input.state);
  if (!input.config.enabled || input.config.url === "" || webhookUrlProblem(input.config.url)) {
    return { state, sent: 0, failed: 0 };
  }
  const candidates = selectCandidates(input.events, state, input.config.events);
  let sent = 0;
  let failed = 0;
  const nowMs = input.now.getTime();
  for (const event of candidates) {
    if (input.signal?.aborted) break;
    const pending = state.attempts[event.id];
    if (pending) {
      const due = Date.parse(pending.nextAt);
      if (!Number.isNaN(due) && due > nowMs) break;
    }
    const result = await postWebhook({
      url: input.config.url,
      secret: input.config.secret,
      payload: eventToPayload(event),
      fetch: input.fetch,
      now: input.now,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!result.ok && result.reason === "aborted") break;
    if (result.ok) {
      rememberDelivered(state, event.id);
      state.last = compactLast({
        at: input.now.toISOString(),
        ok: true,
        status: result.status,
        eventId: event.id,
      });
      sent += 1;
      continue;
    }
    failed += 1;
    const count = (pending?.count ?? 0) + 1;
    state.last = compactLast({
      at: input.now.toISOString(),
      ok: false,
      ...(result.reason === "http" ? { status: result.status } : {}),
      error: result.error,
      eventId: event.id,
    });
    if (count >= WEBHOOK_MAX_ATTEMPTS) {
      rememberDelivered(state, event.id);
      continue;
    }
    const wait = WEBHOOK_BACKOFF_MS[count - 1] ?? WEBHOOK_BACKOFF_MS[4];
    state.attempts[event.id] = {
      count,
      nextAt: new Date(nowMs + wait).toISOString(),
    };
    break;
  }
  return { state, sent, failed };
}

export async function postWebhook(input: {
  url: string;
  secret: string;
  payload: WebhookPayload;
  fetch: WebhookFetch;
  now: Date;
  signal?: AbortSignal;
}): Promise<WebhookPostResult> {
  if (input.signal?.aborted) return { ok: false, reason: "aborted" };
  const host = webhookErrorHost(input.url);
  const body = encodeWebhookBody(input.payload);
  const timestampSeconds = Math.floor(input.now.getTime() / 1000);
  const timeout = AbortSignal.timeout(WEBHOOK_TIMEOUT_MS);
  const signal = followSignals(timeout, input.signal);
  let response: Response;
  try {
    response = await input.fetch(input.url, {
      method: "POST",
      headers: webhookHeaders({
        eventType: input.payload.type,
        deliveryId: input.payload.id,
        timestampSeconds,
        secret: input.secret,
        body,
      }),
      body,
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (input.signal?.aborted) return { ok: false, reason: "aborted" };
    if (timeout.aborted || isTimeoutError(error)) {
      return { ok: false, reason: "timeout", error: `${host}: 超时` };
    }
    return { ok: false, reason: "network", error: `${host}: 连接失败` };
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status >= 200 && response.status < 300) {
    return { ok: true, status: response.status };
  }
  return {
    ok: false,
    reason: "http",
    status: response.status,
    error: `${host}: HTTP ${response.status}`,
  };
}

function selectCandidates(
  events: readonly Event[],
  state: WebhookState,
  kinds: readonly WebhookEventKind[],
): Event[] {
  if (state.enabledAt === null) return [];
  const enabledMs = Date.parse(state.enabledAt);
  if (Number.isNaN(enabledMs)) return [];
  const allowed = new Set<string>(kinds);
  const delivered = new Set(state.delivered);
  const selected: Event[] = [];
  for (const event of events) {
    if (!allowed.has(event.type) || delivered.has(event.id)) continue;
    const ts = Date.parse(event.ts);
    if (Number.isNaN(ts) || ts < enabledMs) continue;
    selected.push(event);
  }
  return selected;
}

function rememberDelivered(state: WebhookState, id: string): void {
  if (!state.delivered.includes(id)) state.delivered.push(id);
  if (state.delivered.length > WEBHOOK_DELIVERED_CAP) {
    state.delivered.splice(0, state.delivered.length - WEBHOOK_DELIVERED_CAP);
  }
  delete state.attempts[id];
}

function cloneState(state: WebhookState): WebhookState {
  const attempts: WebhookState["attempts"] = {};
  for (const [id, attempt] of Object.entries(state.attempts)) {
    attempts[id] = { count: attempt.count, nextAt: attempt.nextAt };
  }
  return {
    enabledAt: state.enabledAt,
    delivered: [...state.delivered],
    attempts,
    last: state.last === null ? null : compactLast(state.last),
  };
}

function compactLast(last: WebhookLast): WebhookLast {
  return {
    at: last.at,
    ok: last.ok,
    ...(last.status !== undefined ? { status: last.status } : {}),
    ...(last.error !== undefined ? { error: scrubError(last.error) } : {}),
    ...(last.eventId !== undefined ? { eventId: last.eventId } : {}),
  };
}

function coerceWebhookState(value: unknown): WebhookState {
  if (value === null || typeof value !== "object") return emptyWebhookState();
  const record = value as Record<string, unknown>;
  const enabledAt =
    typeof record.enabledAt === "string" && !Number.isNaN(Date.parse(record.enabledAt))
      ? record.enabledAt
      : null;
  const delivered = Array.isArray(record.delivered)
    ? record.delivered
        .filter((item): item is string => typeof item === "string" && item !== "")
        .slice(-WEBHOOK_DELIVERED_CAP)
    : [];
  const attempts: WebhookState["attempts"] = {};
  if (record.attempts !== null && typeof record.attempts === "object") {
    for (const [id, attempt] of Object.entries(record.attempts as Record<string, unknown>)) {
      if (attempt === null || typeof attempt !== "object") continue;
      const count = (attempt as { count?: unknown }).count;
      const nextAt = (attempt as { nextAt?: unknown }).nextAt;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1) continue;
      if (typeof nextAt !== "string" || Number.isNaN(Date.parse(nextAt))) continue;
      attempts[id] = { count, nextAt };
    }
  }
  return { enabledAt, delivered, attempts, last: coerceLast(record.last) };
}

function coerceLast(value: unknown): WebhookLast | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== "string" || typeof record.ok !== "boolean") return null;
  const status = typeof record.status === "number" && Number.isInteger(record.status) ? record.status : undefined;
  const error = typeof record.error === "string" ? scrubError(record.error) : undefined;
  const eventId = typeof record.eventId === "string" && record.eventId !== "" ? record.eventId : undefined;
  return compactLast({
    at: record.at,
    ok: record.ok,
    ...(status !== undefined ? { status } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(eventId !== undefined ? { eventId } : {}),
  });
}

/** Drop stored text that still carries a URL, userinfo, or query. */
function scrubError(error: string): string {
  if (error.length > 300 || /[?#]|:\/\/|@/u.test(error)) return "webhook: 连接失败";
  return error;
}

function followSignals(timeout: AbortSignal, parent: AbortSignal | undefined): AbortSignal {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  if (timeout.aborted || parent?.aborted) {
    abort();
    return controller.signal;
  }
  timeout.addEventListener("abort", abort, { once: true });
  parent?.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("name" in error)) return false;
  const name = String(error.name);
  if (name === "TimeoutError") return true;
  if (name !== "AbortError" || !(error instanceof Error)) return false;
  return /timeout/iu.test(error.message);
}
