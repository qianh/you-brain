import type { QuotaView } from "../quota/types.js";
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
  type PortraitProbeActionBody,
  type PortraitProbeActionResult,
  type PortraitProbesResponse,
  type PortraitProposalActionBody,
  type PortraitProposalActionResult,
  type PortraitProposalsResponse,
  type PortraitResponse,
  type PortraitSnapshotsResponse,
  type ReminderActionBody,
  type ReminderReplyBody,
  type ReminderView,
  type RemindersResponse,
  type SearchRequest,
  type SearchResponse,
  type StatusResponse,
  type SyncActionResult,
  type MorningDigestRegenerateResult,
  type TodayResponse,
  type TodoActionBody,
  type TopicDetail,
  type TopicMutationBody,
  type TopicMutationResponse,
  type TopicReorganizeApplyBody,
  type TopicReorganizeResult,
  type TopicReorganizeStatus,
  type TopicsQuery,
  type TopicsResponse,
  type UploadActionInput,
  type UploadActionResult,
  type VirtualDeviceCreateBody,
  type VirtualDeviceResponse,
  type RemoveDeviceResponse,
  type NotionDatabaseView,
  type NotionDeleteBlockBody,
  type NotionTableEditBody,
  type NotionDbCellBody,
  type NotionCreateDatabaseBody,
  type NotionDbSchemaBody,
  type NotionDuplicatePageBody,
  type NotionDbAddRowBody,
  type NotionDbDeleteRowBody,
  type NotionRelocateBlocksBody,
  type NotionPatchBlockBody,
  type NotionCreateBlocksBody,
  type NotionRestoreBlocksBody,
  type NotionUploadFileBody,
  type NotionPageMetaBody,
  type NotionBlocksCreatedResult,
  type NotionDuplicateBlockBody,
  type NotionKeyPutBody,
  type SearchActivePutBody,
  type SearchKeyPutBody,
  type SearchSettings,
  type NotionMoveBlockBody,
  type NotionPageMutationResult,
  type NotionPageView,
  type NotionAppendBlockBody,
  type NotionArchivePageBody,
  type NotionMovePageBody,
  type NotionArchivePageResult,
  type NotionCreatePageBody,
  type NotionCreatePageResult,
  type NotionPatchTitleBody,
  type NotionSearchView,
  type NotionStatusView,
  type NotionSyncResult,
  type NotionTestResult,
  type NotionTreeView,
  type NotionUpdateBlockBody,
  type ReferenceCandidatesResponse,
  type ReferenceContentView,
  type ReferenceKind,
  type ReferenceMaterializeBody,
  type ReferenceMaterializeResponse,
  type DeckTelegramActionBody,
  type DeckTelegramEnrollInviteResponse,
  type DeckTelegramStatusResponse,
  type DispatchDevicesResponse,
  type DispatchFollowupBody,
  type DispatchFollowupResponse,
  type DispatchOutboxItemResponse,
  type DispatchOutboxResponse,
  type DispatchPolicyPutBody,
  type DispatchPolicyResponse,
  type DispatchRdStreamEvent,
  type DispatchSendBody,
  type DispatchSendResponse,
  type DispatchStartThreadBody,
  type DispatchStartThreadResponse,
  type DispatchTrustDeviceBody,
  type DispatchTurnResponse,
} from "./types.js";
import type { Roles, SharedConfig } from "@you-brain/protocol";
import type { UiPrefs, UiPrefsPatch } from "../ui-prefs/store.js";
import type { TaskActionInput, TaskBoard, TaskCreateInput, TaskReview, TaskUpdateInput } from "../tasks/types.js";

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
  taskBoard?(): Promise<TaskBoard>;
  createTask?(input: TaskCreateInput): Promise<TaskBoard>;
  updateTask?(input: TaskUpdateInput): Promise<TaskBoard>;
  taskAction?(input: TaskActionInput): Promise<TaskBoard>;
  taskReview?(id: string): Promise<TaskReview>;
  today(): Promise<TodayResponse>;
  topics(query?: TopicsQuery): Promise<TopicsResponse>;
  topic(id: string): Promise<TopicDetail>;
  updateTopic(id: string, body: TopicMutationBody): Promise<TopicMutationResponse>;
  portrait(variant?: string, project?: string): Promise<PortraitResponse>;
  portraitSnapshots(): Promise<PortraitSnapshotsResponse>;
  portraitCorrections(variant?: string): Promise<PortraitCorrectionsResponse>;
  addPortraitCorrection(input: PortraitCorrectionBody): Promise<PortraitCorrectionResult>;
  portraitProposals?(): Promise<PortraitProposalsResponse>;
  reviewPortraitProposal?(body: PortraitProposalActionBody): Promise<PortraitProposalActionResult>;
  portraitProbes?(): Promise<PortraitProbesResponse>;
  reviewPortraitProbe?(body: PortraitProbeActionBody): Promise<PortraitProbeActionResult>;
  search(query: SearchRequest): Promise<SearchResponse>;
  devices(): Promise<DevicesResponse>;
  addVirtualDevice(body: VirtualDeviceCreateBody): Promise<VirtualDeviceResponse>;
  removeVirtualDevice(deviceId: string): Promise<RemoveDeviceResponse>;
  roles(): Promise<Roles>;
  updateRoles(patch: unknown): Promise<Roles>;
  config(): Promise<SharedConfig>;
  updateConfig(patch: unknown): Promise<SharedConfig>;
  status(): Promise<StatusResponse>;
  uiPrefs(): Promise<{ prefs: UiPrefs }>;
  patchUiPrefs(patch: UiPrefsPatch): Promise<{ prefs: UiPrefs }>;
  quota(): Promise<QuotaView>;
  reminders(all?: boolean): Promise<RemindersResponse>;
  /** Optional so the web client can adopt the write call in a later task. */
  reminderAction?(body: ReminderActionBody): Promise<ReminderView>;
  /** 忽略弹框提醒后用户补的一句话；落在本机，提醒随之关闭。 */
  reminderReply?(body: ReminderReplyBody): Promise<ReminderView>;
  /** Optional so older clients can ignore the manual trigger. */
  consolidate?(body?: ConsolidateActionInput): Promise<ConsolidateActionResult>;
  planTopicReorganization?(body?: { refresh?: boolean }): Promise<TopicReorganizeStatus>;
  topicReorganizeStatus?(): Promise<TopicReorganizeStatus>;
  applyTopicReorganization?(body: TopicReorganizeApplyBody): Promise<TopicReorganizeResult>;
  sync(): Promise<SyncActionResult>;
  regenerateMorningDigest?(): Promise<MorningDigestRegenerateResult>;
  upload(body?: UploadActionInput): Promise<UploadActionResult>;
  todo(body: TodoActionBody): Promise<ActionResponse>;
  conclusion(body: ConclusionActionBody): Promise<ActionResponse>;
  /** 知识库（Notion，只读）。 */
  notionStatus(): Promise<NotionStatusView>;
  notionTree(): Promise<NotionTreeView>;
  notionPage(pageId: string): Promise<NotionPageView>;
  notionSearch(query: string, limit?: number): Promise<NotionSearchView>;
  notionUsers(): Promise<{ users: Array<{ id: string; name: string }> }>;
  notionDatabase(databaseId: string): Promise<NotionDatabaseView>;
  notionSync(): Promise<NotionSyncResult>;
  notionTest(): Promise<NotionTestResult>;
  putNotionKey(body: NotionKeyPutBody): Promise<void>;
  searchSettings(): Promise<SearchSettings>;
  putSearchKey(body: SearchKeyPutBody): Promise<void>;
  putSearchActive(body: SearchActivePutBody): Promise<SearchSettings>;
  /** 编辑块内容,可选同时 turn-into。返回刷新后的页面。 */
  notionUpdateBlock(body: NotionUpdateBlockBody): Promise<NotionPageMutationResult>;
  notionAppendBlock(body: NotionAppendBlockBody): Promise<NotionPageMutationResult>;
  notionDeleteBlock(body: NotionDeleteBlockBody): Promise<NotionPageMutationResult>;
  notionTableEdit(body: NotionTableEditBody): Promise<NotionPageMutationResult>;
  notionRelocateBlocks(body: NotionRelocateBlocksBody): Promise<NotionBlocksCreatedResult>;
  notionPatchBlock(body: NotionPatchBlockBody): Promise<NotionPageMutationResult>;
  notionCreateBlocks(body: NotionCreateBlocksBody): Promise<NotionBlocksCreatedResult>;
  notionRestoreBlocks(body: NotionRestoreBlocksBody): Promise<NotionBlocksCreatedResult>;
  notionUploadFile(body: NotionUploadFileBody): Promise<{ uploadId: string }>;
  notionPageMeta(body: NotionPageMetaBody): Promise<NotionPageMutationResult>;
  notionDbCell(body: NotionDbCellBody): Promise<NotionDatabaseView>;
  notionCreateDatabase(body: NotionCreateDatabaseBody): Promise<{ page: NotionPageView; databaseId: string }>;
  notionDbSchema(body: NotionDbSchemaBody): Promise<NotionDatabaseView>;
  notionDuplicatePage(body: NotionDuplicatePageBody): Promise<NotionArchivePageResult & { pageId: string }>;
  notionDbAddRow(body: NotionDbAddRowBody): Promise<NotionDatabaseView>;
  notionDbDeleteRow(body: NotionDbDeleteRowBody): Promise<NotionDatabaseView>;
  notionMoveBlock(body: NotionMoveBlockBody): Promise<NotionPageMutationResult>;
  notionDuplicateBlock(body: NotionDuplicateBlockBody): Promise<NotionPageMutationResult>;
  notionPatchTitle(body: NotionPatchTitleBody): Promise<NotionPageMutationResult>;
  notionCreatePage(body: NotionCreatePageBody): Promise<NotionCreatePageResult>;
  notionArchivePage(body: NotionArchivePageBody): Promise<NotionArchivePageResult>;
  notionMovePage(body: NotionMovePageBody): Promise<NotionArchivePageResult>;
  /** 只拼 URL;二进制由调用方自行 fetch(浏览器同源 / CLI 拿绝对地址)。 */
  notionAssetUrl(blockId: string): string;
  referenceCandidates(input?: {
    query?: string;
    kinds?: readonly ReferenceKind[];
    limit?: number;
  }): Promise<ReferenceCandidatesResponse>;
  referenceContent(input: {
    uri?: string;
    kind?: ReferenceKind;
    id?: string;
    query?: string;
    label?: string;
  }): Promise<ReferenceContentView>;
  materializeReference(body: ReferenceMaterializeBody): Promise<ReferenceMaterializeResponse>;
  deckTelegramStatus?(): Promise<DeckTelegramStatusResponse>;
  deckTelegramAction?(body: DeckTelegramActionBody): Promise<DeckTelegramStatusResponse>;
  deckTelegramEnrollInvite?(): Promise<DeckTelegramEnrollInviteResponse>;
  dispatchDevices?(): Promise<DispatchDevicesResponse>;
  dispatchStartThread?(body: DispatchStartThreadBody): Promise<DispatchStartThreadResponse>;
  dispatchFollowup?(dispatchId: string, body: DispatchFollowupBody): Promise<DispatchFollowupResponse>;
  dispatchOutbox?(): Promise<DispatchOutboxResponse>;
  dispatchOutboxItem?(dispatchId: string, options?: { refresh?: boolean }): Promise<DispatchOutboxItemResponse>;
  dispatchSend?(body: DispatchSendBody): Promise<DispatchSendResponse>;
  dispatchPolicy?(): Promise<DispatchPolicyResponse>;
  updateDispatchPolicy?(body: DispatchPolicyPutBody): Promise<DispatchPolicyResponse>;
  dispatchTrustDevice?(body: DispatchTrustDeviceBody): Promise<DispatchPolicyResponse>;
  dispatchTurn?(): Promise<DispatchTurnResponse>;
  dispatchRdEvents?(
    listener: (event: DispatchRdStreamEvent) => void,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
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
    taskBoard: () => request("GET", "/api/tasks"),
    createTask: (input) => request("POST", "/api/tasks", input),
    updateTask: (input) => request("PUT", "/api/tasks", input),
    taskAction: (input) => request("POST", "/api/tasks/action", input),
    taskReview: (id) => request("GET", `/api/tasks/review?id=${encodeURIComponent(id)}`),
    today: () => request("GET", "/api/today"),
    topics: (query) => request("GET", `/api/topics${queryString(query)}`),
    topic: (id) => request("GET", `/api/topics/${encodeURIComponent(id)}`),
    updateTopic: (id, body) =>
      request("POST", `/api/topics/${encodeURIComponent(id)}`, body),
    portrait: (variant, project) => {
      const params = new URLSearchParams();
      if (variant !== undefined) params.set("variant", variant);
      if (project !== undefined && project !== "") params.set("project", project);
      const qs = params.toString();
      return request("GET", qs === "" ? "/api/portrait" : `/api/portrait?${qs}`);
    },
    portraitSnapshots: () => request("GET", "/api/portrait/snapshots"),
    portraitCorrections: (variant) =>
      request(
        "GET",
        variant === undefined
          ? "/api/portrait/corrections"
          : `/api/portrait/corrections?variant=${encodeURIComponent(variant)}`,
      ),
    addPortraitCorrection: (input) => request("POST", "/api/portrait/corrections", input),
    portraitProposals: () => request("GET", "/api/portrait/proposals"),
    reviewPortraitProposal: (body) => request("POST", "/api/portrait/proposals", body),
    portraitProbes: () => request("GET", "/api/portrait/probes"),
    reviewPortraitProbe: (body) => request("POST", "/api/portrait/probes", body),
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
    uiPrefs: () => request("GET", "/api/ui-prefs"),
    patchUiPrefs: (patch) => request("PUT", "/api/ui-prefs", patch),
    quota: () => request("GET", "/api/quota"),
    reminders: (all) => request("GET", all ? "/api/reminders?all=1" : "/api/reminders"),
    reminderAction: (body) => request("POST", "/api/actions/reminder", body),
    regenerateMorningDigest: () => request("POST", "/api/actions/morning-digest"),
    reminderReply: (body) => request("POST", "/api/actions/reminder-reply", body),
    consolidate: (body) => request("POST", "/api/actions/consolidate", body ?? {}),
    planTopicReorganization: (body) => request("POST", "/api/actions/topics-reorganize/plan", body ?? {}),
    topicReorganizeStatus: () => request("GET", "/api/actions/topics-reorganize/status"),
    applyTopicReorganization: (body) => request("POST", "/api/actions/topics-reorganize/apply", body),
    sync: () => request("POST", "/api/actions/sync"),
    upload: (body) => request("POST", "/api/actions/upload", body ?? {}),
    todo: (body) => request("POST", "/api/actions/todo", body),
    conclusion: (body) => request("POST", "/api/actions/conclusion", body),
    notionStatus: () => request("GET", "/api/notion"),
    notionTree: () => request("GET", "/api/notion/tree"),
    notionPage: (pageId) =>
      request("GET", `/api/notion/page?id=${encodeURIComponent(pageId)}`),
    notionUsers: () => request("GET", "/api/notion/users"),
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
    searchSettings: () => request("GET", "/api/search-provider"),
    putSearchActive: (body) => request("PUT", "/api/search-provider", body),
    putSearchKey: (body) => request("PUT", "/api/secrets/search", body),
    notionUpdateBlock: (body) => request("POST", "/api/actions/notion-update-block", body),
    notionAppendBlock: (body) => request("POST", "/api/actions/notion-append-block", body),
    notionDeleteBlock: (body) => request("POST", "/api/actions/notion-delete-block", body),
    notionTableEdit: (body) => request("POST", "/api/actions/notion-table-edit", body),
    notionRelocateBlocks: (body) => request("POST", "/api/actions/notion-relocate-blocks", body),
    notionPatchBlock: (body) => request("POST", "/api/actions/notion-patch-block", body),
    notionCreateBlocks: (body) => request("POST", "/api/actions/notion-create-blocks", body),
    notionRestoreBlocks: (body) => request("POST", "/api/actions/notion-restore-blocks", body),
    notionUploadFile: (body) => request("POST", "/api/actions/notion-upload-file", body),
    notionPageMeta: (body) => request("POST", "/api/actions/notion-page-meta", body),
    notionDbCell: (body) => request("POST", "/api/actions/notion-db-cell", body),
    notionCreateDatabase: (body) => request("POST", "/api/actions/notion-create-database", body),
    notionDbSchema: (body) => request("POST", "/api/actions/notion-db-schema", body),
    notionDuplicatePage: (body) => request("POST", "/api/actions/notion-duplicate-page", body),
    notionDbAddRow: (body) => request("POST", "/api/actions/notion-db-add-row", body),
    notionDbDeleteRow: (body) => request("POST", "/api/actions/notion-db-delete-row", body),
    notionMoveBlock: (body) => request("POST", "/api/actions/notion-move-block", body),
    notionDuplicateBlock: (body) => request("POST", "/api/actions/notion-duplicate-block", body),
    notionPatchTitle: (body) => request("POST", "/api/actions/notion-patch-title", body),
    notionCreatePage: (body) => request("POST", "/api/actions/notion-create-page", body),
    notionArchivePage: (body) => request("POST", "/api/actions/notion-archive-page", body),
    notionMovePage: (body) => request("POST", "/api/actions/notion-move-page", body),
    notionAssetUrl: (blockId) =>
      `${baseUrl}/api/notion/asset?block=${encodeURIComponent(blockId)}`,
    referenceCandidates: (input) => {
      const qs = referenceCandidatesQuery(input);
      return request("GET", qs === "" ? "/api/references/candidates" : `/api/references/candidates?${qs}`);
    },
    referenceContent: (input) => {
      const qs = referenceContentQuery(input);
      return request("GET", qs === "" ? "/api/references/content" : `/api/references/content?${qs}`);
    },
    materializeReference: (body) => request("POST", "/api/references/materialize", body),
    deckTelegramStatus: () => request("GET", "/api/deck/telegram"),
    deckTelegramAction: (body) => request("POST", "/api/deck/telegram", body),
    deckTelegramEnrollInvite: () => request("POST", "/api/deck/telegram/enroll-invite"),
    dispatchDevices: () => request("GET", "/api/dispatch/devices"),
    dispatchStartThread: (body) => request("POST", "/api/dispatch/threads", body),
    dispatchFollowup: (dispatchId, body) =>
      request("POST", `/api/dispatch/outbox/${encodeURIComponent(dispatchId)}/followup`, body),
    dispatchOutbox: () => request("GET", "/api/dispatch/outbox"),
    dispatchOutboxItem: (dispatchId, opts) =>
      request(
        "GET",
        `/api/dispatch/outbox/${encodeURIComponent(dispatchId)}${opts?.refresh ? "?refresh=1" : ""}`,
      ),
    dispatchSend: (body) => request("POST", "/api/dispatch/send", body),
    dispatchPolicy: () => request("GET", "/api/dispatch/policy"),
    updateDispatchPolicy: (body) => request("PUT", "/api/dispatch/policy", body),
    dispatchTrustDevice: (body) => request("POST", "/api/dispatch/trust-device", body),
    dispatchTurn: () => request("GET", "/api/dispatch/turn"),
    dispatchRdEvents: (listener, rdOptions) =>
      readRdEvents(fetchImpl, baseUrl, options.token, listener, rdOptions?.signal),
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

function referenceCandidatesQuery(input?: {
  query?: string;
  kinds?: readonly ReferenceKind[];
  limit?: number;
}): string {
  if (!input) return "";
  const params = new URLSearchParams();
  if (input.query !== undefined && input.query !== "") params.set("q", input.query);
  if (input.kinds && input.kinds.length > 0) params.set("kinds", input.kinds.join(","));
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  return params.toString();
}

function referenceContentQuery(input: {
  uri?: string;
  kind?: ReferenceKind;
  id?: string;
  query?: string;
  label?: string;
}): string {
  const params = new URLSearchParams();
  if (input.uri !== undefined) params.set("uri", input.uri);
  if (input.kind !== undefined) params.set("kind", input.kind);
  if (input.id !== undefined) params.set("id", input.id);
  if (input.query !== undefined) params.set("q", input.query);
  if (input.label !== undefined) params.set("label", input.label);
  return params.toString();
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

async function readRdEvents(
  fetchImpl: typeof fetch,
  baseUrl: string,
  token: string,
  listener: (event: DispatchRdStreamEvent) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  const response = await fetchImpl(`${baseUrl}/api/dispatch/rd/events`, {
    headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
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
  let rest = "";
  try {
    while (!signal?.aborted) {
      const chunk = await reader.read();
      if (chunk.done) return;
      rest = (rest + decoder.decode(chunk.value, { stream: true })).replaceAll("\r\n", "\n");
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
        const value = safeParse(data);
        if (
          value !== null &&
          typeof value === "object" &&
          "from" in value &&
          typeof value.from === "string" &&
          "kind" in value &&
          (value.kind === "rd.ice" || value.kind === "rd.state") &&
          "data" in value &&
          value.data !== null &&
          typeof value.data === "object"
        ) {
          listener(value as DispatchRdStreamEvent);
        }
      }
    }
  } catch (error) {
    if (signal?.aborted) return;
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
