import type { DaemonClient } from "@you-brain/core/http/client.js";
import type {
  ActionResponse,
  ApiErrorBody,
  DaemonEvent,
  DevicesResponse,
  PortraitCorrectionBody,
  PortraitCorrectionResult,
  PortraitCorrectionsResponse,
  PortraitResponse,
  PortraitSnapshotsResponse,
  ReminderView,
  RemindersResponse,
  SearchRequest,
  SearchResponse,
  StatusResponse,
  ConsolidateActionResult,
  SyncActionResult,
  TodayResponse,
  TopicDetail,
  TopicMutationResponse,
  TopicsQuery,
  TopicsResponse,
  UploadActionResult,
  VirtualDeviceCreateBody,
  VirtualDeviceResponse,
  RemoveDeviceResponse,
} from "@you-brain/core/http/types.js";
import type { Roles, SharedConfig } from "@you-brain/protocol";

import { drainSse } from "../lib/sse.js";

/**
 * Same-origin fetch client. `createDaemonClient` itself uses only fetch, but
 * importing it evaluates `types.ts`, which pulls Zod and `@you-brain/protocol`
 * (`node:crypto`). The UI imports those modules as types and talks to `/api`
 * on the page origin so the Vite proxy and the daemon-hosted shell match.
 * SSE uses `/api/events?token=`.
 */
export class BrowserDaemonError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BrowserDaemonError";
    this.status = status;
    this.code = code;
  }
}

export interface ActionMessage {
  ok: boolean;
  message: string;
}

export interface OauthSecretInput {
  mode: "official" | "custom";
  clientId: string;
  clientSecret?: string;
}

export type ReminderActionName = "reactivate" | "done" | "snooze" | "mute" | "ignore";

export interface BrowserDaemon extends Omit<DaemonClient, "reminderAction" | "consolidate"> {
  putLlmKey(provider: string, apiKey: string): Promise<void>;
  putOauth(body: OauthSecretInput): Promise<void>;
  testLlm(body: { provider: string; model: string; baseUrl: string }): Promise<ActionMessage>;
  googleLogin(): Promise<ActionMessage>;
  reminderAction(reminderId: string, action: ReminderActionName, until?: string): Promise<ReminderView>;
  consolidate(body?: { force?: boolean }): Promise<ConsolidateActionResult>;
}

export function readDaemonToken(): string {
  const injected = window.__YOU_BRAIN__?.token;
  if (typeof injected === "string" && injected.length > 0) return injected;
  const fromEnv = import.meta.env.VITE_DAEMON_TOKEN;
  return typeof fromEnv === "string" ? fromEnv : "";
}

export function createBrowserDaemon(options?: {
  token?: string;
  fetch?: typeof fetch;
}): BrowserDaemon {
  const token = options?.token ?? readDaemonToken();
  const fetchImpl = options?.fetch ?? fetch;
  const baseUrl = window.location.origin;

  async function request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers = new Headers({ authorization: `Bearer ${token}` });
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetchImpl(path, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法连接 daemon";
      throw new BrowserDaemonError(0, "DAEMON_UNREACHABLE", message);
    }
    const text = await response.text();
    const parsed: unknown = text === "" ? null : parseJson(text);
    if (!response.ok) {
      const errorBody = asError(parsed);
      throw new BrowserDaemonError(
        response.status,
        errorBody?.code ?? "HTTP_ERROR",
        errorBody?.message ?? (response.statusText || "请求失败"),
      );
    }
    return parsed as T;
  }

  return {
    baseUrl,
    today: () => request<TodayResponse>("GET", "/api/today"),
    topics: (query) => request<TopicsResponse>("GET", `/api/topics${queryString(query)}`),
    topic: (id) => request<TopicDetail>("GET", `/api/topics/${encodeURIComponent(id)}`),
    updateTopic: (id, body) =>
      request<TopicMutationResponse>("POST", `/api/topics/${encodeURIComponent(id)}`, body),
    portrait: (variant) =>
      request<PortraitResponse>(
        "GET",
        variant === undefined ? "/api/portrait" : `/api/portrait?variant=${encodeURIComponent(variant)}`,
      ),
    portraitSnapshots: () => request<PortraitSnapshotsResponse>("GET", "/api/portrait/snapshots"),
    portraitCorrections: (variant) =>
      request<PortraitCorrectionsResponse>(
        "GET",
        variant === undefined
          ? "/api/portrait/corrections"
          : `/api/portrait/corrections?variant=${encodeURIComponent(variant)}`,
      ),
    addPortraitCorrection: (input: PortraitCorrectionBody) =>
      request<PortraitCorrectionResult>("POST", "/api/portrait/corrections", input),
    search: (query) => request<SearchResponse>("GET", `/api/search${searchString(query)}`),
    devices: () => request<DevicesResponse>("GET", "/api/devices"),
    addVirtualDevice: (body: VirtualDeviceCreateBody) =>
      request<VirtualDeviceResponse>("POST", "/api/devices/virtual", body),
    removeVirtualDevice: (deviceId: string) =>
      request<RemoveDeviceResponse>("DELETE", `/api/devices/${encodeURIComponent(deviceId)}`),
    roles: () => request<Roles>("GET", "/api/roles"),
    updateRoles: (patch) => request<Roles>("PUT", "/api/roles", patch),
    config: () => request<SharedConfig>("GET", "/api/config"),
    updateConfig: (patch) => request<SharedConfig>("PUT", "/api/config", patch),
    status: () => request<StatusResponse>("GET", "/api/status"),
    reminders: () => request<RemindersResponse>("GET", "/api/reminders"),
    reminderAction: (reminderId, action, until) =>
      request<ReminderView>("POST", "/api/actions/reminder", {
        reminderId,
        action,
        ...(until === undefined ? {} : { until }),
      }),
    consolidate: (body) => request<ConsolidateActionResult>("POST", "/api/actions/consolidate", body ?? {}),
    sync: () => request<SyncActionResult>("POST", "/api/actions/sync"),
    upload: (body) => request<UploadActionResult>("POST", "/api/actions/upload", body ?? {}),
    todo: (body) => request<ActionResponse>("POST", "/api/actions/todo", body),
    conclusion: (body) => request<ActionResponse>("POST", "/api/actions/conclusion", body),
    events: (listener, eventOptions) =>
      readEvents(fetchImpl, token, listener, eventOptions?.signal),
    putLlmKey: async (provider, apiKey) => {
      await request("PUT", "/api/secrets/llm", { provider, apiKey });
    },
    putOauth: async (body) => {
      const payload: Record<string, string> = { mode: body.mode, clientId: body.clientId };
      if (body.clientSecret !== undefined && body.clientSecret !== "") {
        payload.clientSecret = body.clientSecret;
      }
      await request("PUT", "/api/secrets/oauth", payload);
    },
    testLlm: (body) => request<ActionMessage>("POST", "/api/actions/llm-test", body),
    googleLogin: () => request<ActionMessage>("POST", "/api/actions/google-login"),
  };
}

function queryString(query: TopicsQuery | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  if (query.zone !== undefined) params.set("zone", query.zone);
  if (query.status !== undefined) params.set("status", query.status);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

function searchString(query: SearchRequest): string {
  const params = new URLSearchParams();
  params.set("q", query.query);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.from !== undefined) params.set("from", query.from);
  if (query.to !== undefined) params.set("to", query.to);
  for (const source of query.sources ?? []) params.append("sources", source);
  return `?${params.toString()}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BrowserDaemonError(0, "INVALID_RESPONSE", "daemon 返回的不是 JSON");
  }
}

function asError(value: unknown): ApiErrorBody["error"] | null {
  if (value === null || typeof value !== "object" || !("error" in value)) return null;
  const error = value.error;
  if (error === null || typeof error !== "object") return null;
  const code = "code" in error && typeof error.code === "string" ? error.code : null;
  const message = "message" in error && typeof error.message === "string" ? error.message : null;
  if (code === null || message === null) return null;
  return { code, message };
}

function asDaemonEvent(value: unknown): DaemonEvent | null {
  if (value === null || typeof value !== "object") return null;
  const id = "id" in value ? value.id : undefined;
  const kind = "kind" in value ? value.kind : undefined;
  const at = "at" in value ? value.at : undefined;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 0) return null;
  if (
    kind !== "ready" &&
    kind !== "topics" &&
    kind !== "today" &&
    kind !== "status" &&
    kind !== "portrait" &&
    kind !== "devices"
  ) {
    return null;
  }
  if (typeof at !== "string" || at.length === 0) return null;
  return { id, kind, at };
}

async function readEvents(
  fetchImpl: typeof fetch,
  token: string,
  listener: (event: DaemonEvent) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  const response = await fetchImpl(`/api/events?token=${encodeURIComponent(token)}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "text/event-stream",
    },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    const parsed = text === "" ? null : safeParse(text);
    const errorBody = asError(parsed);
    throw new BrowserDaemonError(
      response.status,
      errorBody?.code ?? "HTTP_ERROR",
      errorBody?.message ?? (response.statusText || "实时更新失败"),
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal?.aborted) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parsed = drainSse(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        const event = asDaemonEvent(safeParse(frame.data));
        if (event) listener(event);
      }
    }
  } catch (error) {
    if (signal?.aborted) return;
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
