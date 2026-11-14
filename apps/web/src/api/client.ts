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
  TopicReorganizeApplyBody,
  TopicReorganizeResult,
  TopicReorganizeStatus,
  TopicsQuery,
  TopicsResponse,
  UploadActionResult,
  VirtualDeviceCreateBody,
  VirtualDeviceResponse,
  RemoveDeviceResponse,
  NotionArchivePageBody,
  NotionMovePageBody,
  NotionArchivePageResult,
  NotionCreatePageBody,
  NotionCreatePageResult,
  NotionDatabaseView,
  NotionDeleteBlockBody,
  NotionTableEditBody,
  NotionDbCellBody,
  NotionCreateDatabaseBody,
  NotionDbSchemaBody,
  NotionDuplicatePageBody,
  NotionDbAddRowBody,
  NotionDbDeleteRowBody,
  NotionRelocateBlocksBody,
  NotionPatchBlockBody,
  NotionCreateBlocksBody,
  NotionRestoreBlocksBody,
  NotionUploadFileBody,
  NotionPageMetaBody,
  NotionBlocksCreatedResult,
  NotionDuplicateBlockBody,
  NotionKeyPutBody,
  SearchActivePutBody,
  SearchKeyPutBody,
  SearchSettings,
  NotionMoveBlockBody,
  NotionPageMutationResult,
  NotionPageView,
  NotionAppendBlockBody,
  NotionPatchTitleBody,
  NotionSearchView,
  NotionStatusView,
  NotionSyncResult,
  NotionTestResult,
  NotionTreeView,
  NotionUpdateBlockBody,
  WebhookPublic,
  WebhookPutBody,
  WebhookTestResult,
  OAuthClientPublic,
  OAuthClientPutBody,
  DeckDshWebResponse,
  DeckTty7PasteImageResponse,
  DeckTty7ScreenResponse,
  DeckTty7SendBody,
  DeckTty7SessionsResponse,
  DeckTty7StartBody,
  DeckTty7StartResponse,
  DeckTerminalSize,
  LlmModelsView,
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

export type ReminderActionName = "reactivate" | "done" | "snooze" | "mute" | "ignore";

export interface BrowserDaemon
  extends Omit<
    DaemonClient,
    | "reminderAction"
    | "consolidate"
    | "planTopicReorganization"
    | "topicReorganizeStatus"
    | "applyTopicReorganization"
  > {
  planTopicReorganization(body?: { refresh?: boolean }): Promise<TopicReorganizeStatus>;
  topicReorganizeStatus(): Promise<TopicReorganizeStatus>;
  applyTopicReorganization(body: TopicReorganizeApplyBody): Promise<TopicReorganizeResult>;
  putLlmKey(provider: string, apiKey: string): Promise<void>;
  testLlm(body: { provider: string; model: string; baseUrl: string }): Promise<ActionMessage>;
  llmModels(input: { provider: string; baseUrl?: string }): Promise<LlmModelsView>;
  googleLogin(): Promise<ActionMessage>;
  googleLogout(): Promise<ActionMessage>;
  googleSwitch(): Promise<ActionMessage>;
  /** 自带 OAuth 凭据（每人自己的 Google Cloud 项目）。 */
  oauthClient(): Promise<OAuthClientPublic>;
  putOAuthClient(body: OAuthClientPutBody): Promise<OAuthClientPublic>;
  webhook(): Promise<WebhookPublic>;
  updateWebhook(body: WebhookPutBody): Promise<WebhookPublic>;
  testWebhook(): Promise<WebhookTestResult>;
  reminderAction(reminderId: string, action: ReminderActionName, until?: string): Promise<ReminderView>;
  /** 提醒被截短的原文;没有更多内容为 null。 */
  reminderDetail(reminderId: string): Promise<{ detail: string | null }>;
  consolidate(body?: { force?: boolean }): Promise<ConsolidateActionResult>;
  /** 知识库(Notion,只读)。 */
  notionStatus(): Promise<NotionStatusView>;
  notionTree(): Promise<NotionTreeView>;
  notionPage(pageId: string): Promise<NotionPageView>;
  notionSearch(query: string, limit?: number): Promise<NotionSearchView>;
  /** 工作区成员(@ 提及)。 */
  notionUsers(): Promise<{ users: Array<{ id: string; name: string }> }>;
  notionDatabase(databaseId: string): Promise<NotionDatabaseView>;
  notionSync(): Promise<NotionSyncResult>;
  notionTest(): Promise<NotionTestResult>;
  putNotionKey(body: NotionKeyPutBody): Promise<void>;
  searchSettings(): Promise<SearchSettings>;
  putSearchKey(body: SearchKeyPutBody): Promise<void>;
  putSearchActive(body: SearchActivePutBody): Promise<SearchSettings>;
  /** 编辑块内容(可选 turn-into)/增删/移动/复制/改标题,均返回刷新后的页面。 */
  notionUpdateBlock(body: NotionUpdateBlockBody): Promise<NotionPageMutationResult>;
  notionAppendBlock(body: NotionAppendBlockBody): Promise<NotionPageMutationResult>;
  notionDeleteBlock(body: NotionDeleteBlockBody): Promise<NotionPageMutationResult>;
  notionTableEdit(body: NotionTableEditBody): Promise<NotionPageMutationResult>;
  /** 移动/复制/转类型(带整棵子树,任意可新建的块类型)。 */
  notionRelocateBlocks(body: NotionRelocateBlocksBody): Promise<NotionBlocksCreatedResult>;
  /** 改块属性(颜色、可折叠、图标、链接、说明、公式等),类型不变。 */
  notionPatchBlock(body: NotionPatchBlockBody): Promise<NotionPageMutationResult>;
  /** 新建任意类型的块(带子树)。 */
  notionCreateBlocks(body: NotionCreateBlocksBody): Promise<NotionBlocksCreatedResult>;
  /** 撤销删除:恢复归档的块。 */
  notionRestoreBlocks(body: NotionRestoreBlocksBody): Promise<NotionBlocksCreatedResult>;
  notionUploadFile(body: NotionUploadFileBody): Promise<{ uploadId: string }>;
  /** 页面图标与封面。 */
  notionPageMeta(body: NotionPageMetaBody): Promise<NotionPageMutationResult>;
  /** 内嵌数据库:改单元格、新建/删除行。 */
  notionDbCell(body: NotionDbCellBody): Promise<NotionDatabaseView>;
  notionCreateDatabase(body: NotionCreateDatabaseBody): Promise<{ page: NotionPageView; databaseId: string }>;
  notionDbSchema(body: NotionDbSchemaBody): Promise<NotionDatabaseView>;
  /** 复制页面(正文一起)。 */
  notionDuplicatePage(body: NotionDuplicatePageBody): Promise<NotionArchivePageResult & { pageId: string }>;
  notionDbAddRow(body: NotionDbAddRowBody): Promise<NotionDatabaseView>;
  notionDbDeleteRow(body: NotionDbDeleteRowBody): Promise<NotionDatabaseView>;
  notionMoveBlock(body: NotionMoveBlockBody): Promise<NotionPageMutationResult>;
  notionDuplicateBlock(body: NotionDuplicateBlockBody): Promise<NotionPageMutationResult>;
  notionPatchTitle(body: NotionPatchTitleBody): Promise<NotionPageMutationResult>;
  notionCreatePage(body: NotionCreatePageBody): Promise<NotionCreatePageResult>;
  notionArchivePage(body: NotionArchivePageBody): Promise<NotionArchivePageResult>;
  notionMovePage(body: NotionMovePageBody): Promise<NotionArchivePageResult>;
  /** 同源相对路径,直接放进 <img src> / <a href>。 */
  notionAssetUrl(blockId: string): string;
  /** 指挥台。 */
  deckDsh(retry?: boolean): Promise<DeckDshWebResponse>;
  /** tty7 会话桥：列会话、看屏幕、发指令、新开会话；粘贴图片落盘换路径。 */
  deckTty7Sessions(): Promise<DeckTty7SessionsResponse>;
  deckTty7Delete(pane: number): Promise<{ ok: true }>;
  deckTty7Screen(pane: number): Promise<DeckTty7ScreenResponse>;
  deckTty7Send(body: DeckTty7SendBody): Promise<{ ok: true }>;
  deckTty7Start(body: DeckTty7StartBody): Promise<DeckTty7StartResponse>;
  deckTty7PasteImage(data: Blob): Promise<DeckTty7PasteImageResponse>;
  deckTty7Terminal(pane: number, size: DeckTerminalSize): WebSocket;
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
    // Bearer auth is sufficient; dsh's cookies share this host across ports.
    const init: RequestInit = { method, headers, credentials: "omit" };
    if (body !== undefined) {
      if (body instanceof Blob) {
        // 二进制（如粘贴的图片）原样发，类型随 Blob。
        headers.set("content-type", body.type || "application/octet-stream");
        init.body = body;
      } else {
        headers.set("content-type", "application/json");
        init.body = JSON.stringify(body);
      }
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
    reminderDetail: (reminderId) =>
      request<{ detail: string | null }>("GET", `/api/reminder-detail?id=${encodeURIComponent(reminderId)}`),
    reminderAction: (reminderId, action, until) =>
      request<ReminderView>("POST", "/api/actions/reminder", {
        reminderId,
        action,
        ...(until === undefined ? {} : { until }),
      }),
    consolidate: (body) => request<ConsolidateActionResult>("POST", "/api/actions/consolidate", body ?? {}),
    planTopicReorganization: (body) =>
      request<TopicReorganizeStatus>("POST", "/api/actions/topics-reorganize/plan", body ?? {}),
    topicReorganizeStatus: () =>
      request<TopicReorganizeStatus>("GET", "/api/actions/topics-reorganize/status"),
    applyTopicReorganization: (body) =>
      request<TopicReorganizeResult>("POST", "/api/actions/topics-reorganize/apply", body),
    sync: () => request<SyncActionResult>("POST", "/api/actions/sync"),
    upload: (body) => request<UploadActionResult>("POST", "/api/actions/upload", body ?? {}),
    todo: (body) => request<ActionResponse>("POST", "/api/actions/todo", body),
    conclusion: (body) => request<ActionResponse>("POST", "/api/actions/conclusion", body),
    events: (listener, eventOptions) =>
      readEvents(fetchImpl, token, listener, eventOptions?.signal),
    putLlmKey: async (provider, apiKey) => {
      await request("PUT", "/api/secrets/llm", { provider, apiKey });
    },
    testLlm: (body) => request<ActionMessage>("POST", "/api/actions/llm-test", body),
    llmModels: (input) =>
      request<LlmModelsView>(
        "GET",
        `/api/llm-models?provider=${encodeURIComponent(input.provider)}${
          input.baseUrl !== undefined && input.baseUrl !== "" ? `&baseUrl=${encodeURIComponent(input.baseUrl)}` : ""
        }`,
      ),
    googleLogin: () => request<ActionMessage>("POST", "/api/actions/google-login"),
    googleLogout: () => request<ActionMessage>("POST", "/api/actions/google-logout"),
    googleSwitch: () => request<ActionMessage>("POST", "/api/actions/google-switch"),
    oauthClient: () => request<OAuthClientPublic>("GET", "/api/oauth-client"),
    putOAuthClient: (body) => request<OAuthClientPublic>("PUT", "/api/oauth-client", body),
    webhook: () => request<WebhookPublic>("GET", "/api/webhook"),
    updateWebhook: (body) => request<WebhookPublic>("PUT", "/api/webhook", body),
    testWebhook: () => request<WebhookTestResult>("POST", "/api/actions/webhook-test"),
    notionStatus: () => request<NotionStatusView>("GET", "/api/notion"),
    notionTree: () => request<NotionTreeView>("GET", "/api/notion/tree"),
    notionPage: (pageId: string) =>
      request<NotionPageView>("GET", `/api/notion/page?id=${encodeURIComponent(pageId)}`),
    notionUsers: () => request<{ users: Array<{ id: string; name: string }> }>("GET", "/api/notion/users"),
    notionSearch: (query: string, limit?: number) =>
      request<NotionSearchView>(
        "GET",
        `/api/notion/search?q=${encodeURIComponent(query)}${limit === undefined ? "" : `&limit=${limit}`}`,
      ),
    notionDatabase: (databaseId: string) =>
      request<NotionDatabaseView>("GET", `/api/notion/database?id=${encodeURIComponent(databaseId)}`),
    notionSync: () => request<NotionSyncResult>("POST", "/api/actions/notion-sync"),
    notionTest: () => request<NotionTestResult>("POST", "/api/actions/notion-test"),
    deckDsh: (retry?: boolean) =>
      request<DeckDshWebResponse>("GET", retry === true ? "/api/deck/dsh?retry=1" : "/api/deck/dsh"),
    deckTty7Sessions: () => request<DeckTty7SessionsResponse>("GET", "/api/deck/tty7/sessions"),
    deckTty7Delete: (pane: number) => request<{ ok: true }>("POST", "/api/deck/tty7/delete", { pane }),
    deckTty7Screen: (pane: number) => request<DeckTty7ScreenResponse>("GET", `/api/deck/tty7/screen?pane=${pane}`),
    deckTty7Send: (body: DeckTty7SendBody) => request<{ ok: true }>("POST", "/api/deck/tty7/send", body),
    deckTty7Start: (body: DeckTty7StartBody) => request<DeckTty7StartResponse>("POST", "/api/deck/tty7/start", body),
    deckTty7PasteImage: (data: Blob) => request<DeckTty7PasteImageResponse>("POST", "/api/deck/tty7/paste-image", data),
    deckTty7Terminal(pane, size) {
      const url = new URL("/api/deck/tty7/terminal", baseUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "connect", token, pane, size })), { once: true });
      return socket;
    },
    putNotionKey: async (body: NotionKeyPutBody) => {
      await request("PUT", "/api/secrets/notion", body);
    },
    searchSettings: () => request<SearchSettings>("GET", "/api/search-provider"),
    putSearchActive: (body: SearchActivePutBody) =>
      request<SearchSettings>("PUT", "/api/search-provider", body),
    putSearchKey: async (body: SearchKeyPutBody) => {
      await request("PUT", "/api/secrets/search", body);
    },
    notionUpdateBlock: (body: NotionUpdateBlockBody) =>
      request<NotionPageMutationResult>("POST", "/api/actions/notion-update-block", body),
    notionAppendBlock: (body: NotionAppendBlockBody) =>
      request<NotionPageMutationResult>("POST", "/api/actions/notion-append-block", body),
    notionDeleteBlock: (body: NotionDeleteBlockBody) =>
      request<NotionPageMutationResult>("POST", "/api/actions/notion-delete-block", body),
    notionTableEdit: (body: NotionTableEditBody) =>
      request<NotionPageMutationResult>("POST", "/api/actions/notion-table-edit", body),
    notionRelocateBlocks: (body: NotionRelocateBlocksBody) =>
      request<NotionBlocksCreatedResult>("POST", "/api/actions/notion-relocate-blocks", body),
    notionPatchBlock: (body: NotionPatchBlockBody) =>
      request<NotionPageMutationResult>("POST", "/api/actions/notion-patch-block", body),
    notionCreateBlocks: (body: NotionCreateBlocksBody) =>
      request<NotionBlocksCreatedResult>("POST", "/api/actions/notion-create-blocks", body),
    notionRestoreBlocks: (body: NotionRestoreBlocksBody) =>
      request<NotionBlocksCreatedResult>("POST", "/api/actions/notion-restore-blocks", body),
    notionUploadFile: (body: NotionUploadFileBody) =>
      request<{ uploadId: string }>("POST", "/api/actions/notion-upload-file", body),
    notionPageMeta: (body: NotionPageMetaBody) =>
      request<NotionPageMutationResult>("POST", "/api/actions/notion-page-meta", body),
    notionDbCell: (body: NotionDbCellBody) => request<NotionDatabaseView>("POST", "/api/actions/notion-db-cell", body),
    notionCreateDatabase: (body: NotionCreateDatabaseBody) =>
      request<{ page: NotionPageView; databaseId: string }>("POST", "/api/actions/notion-create-database", body),
    notionDbSchema: (body: NotionDbSchemaBody) => request<NotionDatabaseView>("POST", "/api/actions/notion-db-schema", body),
    notionDuplicatePage: (body: NotionDuplicatePageBody) =>
      request<NotionArchivePageResult & { pageId: string }>("POST", "/api/actions/notion-duplicate-page", body),
    notionDbAddRow: (body: NotionDbAddRowBody) => request<NotionDatabaseView>("POST", "/api/actions/notion-db-add-row", body),
    notionDbDeleteRow: (body: NotionDbDeleteRowBody) => request<NotionDatabaseView>("POST", "/api/actions/notion-db-delete-row", body),
    notionMoveBlock: (body: NotionMoveBlockBody) =>
      request<NotionPageMutationResult>("POST", "/api/actions/notion-move-block", body),
    notionDuplicateBlock: (body: NotionDuplicateBlockBody) =>
      request<NotionPageMutationResult>("POST", "/api/actions/notion-duplicate-block", body),
    notionPatchTitle: (body: NotionPatchTitleBody) =>
      request<NotionPageMutationResult>("POST", "/api/actions/notion-patch-title", body),
    notionCreatePage: (body: NotionCreatePageBody) =>
      request<NotionCreatePageResult>("POST", "/api/actions/notion-create-page", body),
    notionMovePage: (body: NotionMovePageBody) =>
      request<NotionArchivePageResult>("POST", "/api/actions/notion-move-page", body),
    notionArchivePage: (body: NotionArchivePageBody) =>
      request<NotionArchivePageResult>("POST", "/api/actions/notion-archive-page", body),
    notionAssetUrl: (blockId: string) => `/api/notion/asset?block=${encodeURIComponent(blockId)}`,
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
    credentials: "omit",
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
