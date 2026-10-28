import {
  DaemonEventSchema,
  type ActionResponse,
  type ApiErrorBody,
  type ConclusionActionBody,
  type ConsolidateActionInput,
  type ConsolidateActionResult,
  type DaemonEvent,
  type DevicesResponse,
  type PortraitCorrectionBody,
  type PortraitCorrectionResult,
  type PortraitCorrectionsResponse,
  type PortraitResponse,
  type PortraitSnapshotsResponse,
  type ReminderActionBody,
  type ReminderView,
  type RemindersResponse,
  type SearchRequest,
  type SearchResponse,
  type StatusResponse,
  type SyncActionResult,
  type TodayResponse,
  type TodoActionBody,
  type TopicDetail,
  type TopicMutationBody,
  type TopicMutationResponse,
  type TopicsQuery,
  type TopicsResponse,
  type UploadActionInput,
  type UploadActionResult,
  type VirtualDeviceCreateBody,
  type VirtualDeviceResponse,
  type RemoveDeviceResponse,
  type WebhookPublic,
  type WebhookPutBody,
  type WebhookTestResult,
  type NotionDatabaseView,
  type NotionKeyPutBody,
  type NotionPageView,
  type NotionSearchView,
  type NotionStatusView,
  type NotionSyncResult,
  type NotionTestResult,
  type NotionTreeView,
} from "./types.js";
import type { Roles, SharedConfig } from "@you-brain/protocol";

export class DaemonClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DaemonClientError";
  }
}

export interface DaemonClient {
  readonly baseUrl: string;
  today(): Promise<TodayResponse>;
  topics(query?: TopicsQuery): Promise<TopicsResponse>;
  topic(id: string): Promise<TopicDetail>;
  updateTopic(id: string, body: TopicMutationBody): Promise<TopicMutationResponse>;
  portrait(variant?: string): Promise<PortraitResponse>;
  portraitSnapshots(): Promise<PortraitSnapshotsResponse>;
  portraitCorrections(variant?: string): Promise<PortraitCorrectionsResponse>;
  addPortraitCorrection(input: PortraitCorrectionBody): Promise<PortraitCorrectionResult>;
  search(query: SearchRequest): Promise<SearchResponse>;
  devices(): Promise<DevicesResponse>;
  addVirtualDevice(body: VirtualDeviceCreateBody): Promise<VirtualDeviceResponse>;
  removeVirtualDevice(deviceId: string): Promise<RemoveDeviceResponse>;
  roles(): Promise<Roles>;
  updateRoles(patch: unknown): Promise<Roles>;
  config(): Promise<SharedConfig>;
  updateConfig(patch: unknown): Promise<SharedConfig>;
  status(): Promise<StatusResponse>;
  webhook(): Promise<WebhookPublic>;
  updateWebhook(body: WebhookPutBody): Promise<WebhookPublic>;
  testWebhook(): Promise<WebhookTestResult>;
  reminders(all?: boolean): Promise<RemindersResponse>;
  /** Optional so the web client can adopt the write call in a later task. */
  reminderAction?(body: ReminderActionBody): Promise<ReminderView>;
  /** Optional so older clients can ignore the manual trigger. */
  consolidate?(body?: ConsolidateActionInput): Promise<ConsolidateActionResult>;
  sync(): Promise<SyncActionResult>;
  upload(body?: UploadActionInput): Promise<UploadActionResult>;
  todo(body: TodoActionBody): Promise<ActionResponse>;
  conclusion(body: ConclusionActionBody): Promise<ActionResponse>;
  /** 知识库（Notion，只读）。 */
  notionStatus(): Promise<NotionStatusView>;
  notionTree(): Promise<NotionTreeView>;
  notionPage(pageId: string): Promise<NotionPageView>;
  notionSearch(query: string, limit?: number): Promise<NotionSearchView>;
  notionDatabase(databaseId: string): Promise<NotionDatabaseView>;
  notionSync(): Promise<NotionSyncResult>;
  notionTest(): Promise<NotionTestResult>;
  putNotionKey(body: NotionKeyPutBody): Promise<void>;
  /** 只拼 URL;二进制由调用方自行 fetch(浏览器同源 / CLI 拿绝对地址)。 */
  notionAssetUrl(blockId: string): string;
  events(
    listener: (event: DaemonEvent) => void,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}

export interface DaemonClientOptions {
  port: number;
  token: string;
  fetch?: typeof fetch;
}

/** HTTP client for the loopback daemon. CLI and Web UI share these types. */
export function createDaemonClient(options: DaemonClientOptions): DaemonClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = `http://127.0.0.1:${options.port}`;

  async function request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers = new Headers({ authorization: `Bearer ${options.token}` });
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法连接 daemon";
      throw new DaemonClientError(0, "DAEMON_UNREACHABLE", message);
    }
    const text = await response.text();
    const parsed: unknown = text === "" ? null : parseJson(text);
    if (!response.ok) {
      const errorBody = asError(parsed);
      throw new DaemonClientError(
        response.status,
        errorBody?.code ?? "HTTP_ERROR",
        errorBody?.message ?? response.statusText,
      );
    }
    return parsed as T;
  }

  return {
    baseUrl,
    today: () => request("GET", "/api/today"),
    topics: (query) => request("GET", `/api/topics${queryString(query)}`),
    topic: (id) => request("GET", `/api/topics/${encodeURIComponent(id)}`),
    updateTopic: (id, body) =>
      request("POST", `/api/topics/${encodeURIComponent(id)}`, body),
    portrait: (variant) =>
      request(
        "GET",
        variant === undefined
          ? "/api/portrait"
          : `/api/portrait?variant=${encodeURIComponent(variant)}`,
      ),
    portraitSnapshots: () => request("GET", "/api/portrait/snapshots"),
    portraitCorrections: (variant) =>
      request(
        "GET",
        variant === undefined
          ? "/api/portrait/corrections"
          : `/api/portrait/corrections?variant=${encodeURIComponent(variant)}`,
      ),
    addPortraitCorrection: (input) => request("POST", "/api/portrait/corrections", input),
    search: (query) => request("GET", `/api/search${searchString(query)}`),
    devices: () => request("GET", "/api/devices"),
    addVirtualDevice: (body) => request("POST", "/api/devices/virtual", body),
    removeVirtualDevice: (deviceId) =>
      request("DELETE", `/api/devices/${encodeURIComponent(deviceId)}`),
    roles: () => request("GET", "/api/roles"),
    updateRoles: (patch) => request("PUT", "/api/roles", patch),
    config: () => request("GET", "/api/config"),
    updateConfig: (patch) => request("PUT", "/api/config", patch),
    status: () => request("GET", "/api/status"),
    webhook: () => request("GET", "/api/webhook"),
    updateWebhook: (body) => request("PUT", "/api/webhook", body),
    testWebhook: () => request("POST", "/api/actions/webhook-test"),
    reminders: (all) => request("GET", all ? "/api/reminders?all=1" : "/api/reminders"),
    reminderAction: (body) => request("POST", "/api/actions/reminder", body),
    consolidate: (body) => request("POST", "/api/actions/consolidate", body ?? {}),
    sync: () => request("POST", "/api/actions/sync"),
    upload: (body) => request("POST", "/api/actions/upload", body ?? {}),
    todo: (body) => request("POST", "/api/actions/todo", body),
    conclusion: (body) => request("POST", "/api/actions/conclusion", body),
    notionStatus: () => request("GET", "/api/notion"),
    notionTree: () => request("GET", "/api/notion/tree"),
    notionPage: (pageId) =>
      request("GET", `/api/notion/page?id=${encodeURIComponent(pageId)}`),
    notionSearch: (query, limit) =>
      request(
        "GET",
        `/api/notion/search?q=${encodeURIComponent(query)}${limit === undefined ? "" : `&limit=${limit}`}`,
      ),
    notionDatabase: (databaseId) =>
      request("GET", `/api/notion/database?id=${encodeURIComponent(databaseId)}`),
    notionSync: () => request("POST", "/api/actions/notion-sync"),
    notionTest: () => request("POST", "/api/actions/notion-test"),
    putNotionKey: (body) => request("PUT", "/api/secrets/notion", body),
    notionAssetUrl: (blockId) =>
      `${baseUrl}/api/notion/asset?block=${encodeURIComponent(blockId)}`,
    events: (listener, eventOptions) =>
      readEvents(fetchImpl, baseUrl, options.token, listener, eventOptions?.signal),
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
    throw new DaemonClientError(0, "INVALID_RESPONSE", "daemon 返回的不是 JSON");
  }
}

function asError(value: unknown): ApiErrorBody["error"] | null {
  if (value === null || typeof value !== "object" || !("error" in value)) return null;
  const error = (value as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return null;
  const code = "code" in error && typeof error.code === "string" ? error.code : null;
  const message =
    "message" in error && typeof error.message === "string" ? error.message : null;
  if (code === null || message === null) return null;
  return { code, message };
}

async function readEvents(
  fetchImpl: typeof fetch,
  baseUrl: string,
  token: string,
  listener: (event: DaemonEvent) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  const response = await fetchImpl(`${baseUrl}/api/events`, {
    headers: { authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    const parsed = text === "" ? null : safeParse(text);
    const errorBody = asError(parsed);
    throw new DaemonClientError(
      response.status,
      errorBody?.code ?? "HTTP_ERROR",
      errorBody?.message ?? response.statusText,
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
      for (const event of parsed.events) listener(event);
    }
  } catch (error) {
    if (signal?.aborted) return;
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function drainSse(buffer: string): { events: DaemonEvent[]; rest: string } {
  const events: DaemonEvent[] = [];
  let rest = buffer.replaceAll("\r\n", "\n");
  while (true) {
    const split = rest.indexOf("\n\n");
    if (split < 0) break;
    const raw = rest.slice(0, split);
    rest = rest.slice(split + 2);
    const data = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data === "") continue;
    try {
      const event = DaemonEventSchema.parse(JSON.parse(data));
      events.push(event);
    } catch {
      // Ignore a malformed frame and keep the stream.
    }
  }
  return { events, rest };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
