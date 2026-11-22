import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LaunchModeSchema, TodoStatusSchema, TopicStatusSchema, type LaunchModeName } from "@you-brain/protocol";
import { z } from "zod";

import {
  SessionSourceSchema,
  type SessionSource,
} from "../domain/session.js";
import {
  listReferenceCandidates,
  resolveReference,
  type ReferencePorts,
} from "../reference/index.js";

import {
  ReferenceKindSchema,
  type ActionResponse,
  type DispatchDevicesResponse,
  type DispatchFollowupBody,
  type DispatchFollowupResponse,
  type DispatchOutboxItemResponse,
  type DispatchStartThreadBody,
  type DispatchStartThreadResponse,
  type NotionPageView,
  type NotionSearchView,
  type PortraitCorrectionResult,
  type PortraitCorrectionsResponse,
  type PortraitResponse,
  type ReferenceCandidateView,
  type ReferenceCandidatesResponse,
  type ReferenceContentView,
  type ReferenceKind,
  type RemindersResponse,
  SearchRequest,
  SearchResponse,
  TodayResponse,
  TopicDetail,
  TopicMutationResponse,
  TopicsQuery,
  TopicsResponse,
  UploadActionInput,
  UploadActionResult,
} from "../http/types.js";

const SessionKeySchema = z.string().regex(/^[a-f0-9]{64}$/u);

export interface SessionContent {
  source: SessionSource;
  conversationId: string;
  content: string;
  updatedAt: string;
}

export interface PortraitContent {
  variant: string;
  portrait: string;
  warnings: Array<{ code: string; message: string }>;
}

export type UpdateTopicInput =
  | { action: "status"; topic_id: string; status: z.infer<typeof TopicStatusSchema> }
  | {
      action: "rename";
      topic_id: string;
      name: string;
      aliases?: string[] | undefined;
    }
  | { action: "merge"; topic_id: string; into_topic_id: string }
  | {
      action: "split";
      topic_id: string;
      session_key: string;
      assign_topic_id?: string | undefined;
      create_name?: string | undefined;
      create_aliases?: string[] | undefined;
    }
  | {
      action: "todo";
      topic_id: string;
      todo_id: string;
      status: z.infer<typeof TodoStatusSchema>;
    }
  | {
      action: "conclusion";
      topic_id: string;
      text: string;
      session_key: string;
    };

export interface GetPortraitMcpInput {
  variant?: string;
  project?: string;
  fullProjects?: boolean;
}

export interface McpDispatchClient {
  devices(): Promise<DispatchDevicesResponse>;
  startThread(body: DispatchStartThreadBody): Promise<DispatchStartThreadResponse>;
  getOutbox(dispatchId: string, options?: { refresh?: boolean }): Promise<DispatchOutboxItemResponse>;
  followup(dispatchId: string, body: DispatchFollowupBody): Promise<DispatchFollowupResponse>;
}

export interface McpServices {
  searchSessions(input: SearchRequest & { limit?: number }): Promise<SearchResponse>;
  getSession(input: {
    source: SessionSource;
    conversationId: string;
  }): Promise<SessionContent>;
  getPortrait(input: GetPortraitMcpInput): Promise<PortraitContent | PortraitResponse>;
  hubStatus(): Promise<object>;
  uploadSessions(input: UploadActionInput): Promise<UploadActionResult>;
  getToday(): Promise<TodayResponse>;
  getTopics(query: TopicsQuery): Promise<TopicsResponse>;
  getTopic(topicId: string): Promise<TopicDetail>;
  updateTopic(
    input: UpdateTopicInput,
  ): Promise<TopicMutationResponse | ActionResponse>;
  getReminders(): Promise<RemindersResponse>;
  addPortraitCorrection(input: {
    variant?: string;
    section: string;
    text: string;
  }): Promise<PortraitCorrectionResult>;
  getPortraitCorrections(input: { variant?: string }): Promise<PortraitCorrectionsResponse>;
  /** 知识库（Notion，只读）。 */
  notionSearch(input: { query: string; limit?: number }): Promise<NotionSearchView>;
  notionPage(input: { pageId: string }): Promise<NotionPageView>;
  /** 统一 @ 引用候选与正文读取（可选；未实现时从上方基础服务组装）。 */
  searchReferences?(input: {
    query?: string;
    kinds?: ReferenceKind[];
    limit?: number;
  }): Promise<ReferenceCandidatesResponse>;
  getReference?(input: {
    uri?: string;
    query?: string;
    kind?: ReferenceKind;
  }): Promise<{ content: ReferenceContentView | null; candidates: ReferenceCandidateView[] }>;
  /** 跨设备派活（经本机 daemon HTTP）；未提供时工具返回明确错误。 */
  dispatch?: McpDispatchClient;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

function success(output: object, text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: output as Record<string, unknown>,
  };
}

function failure(error: unknown): ToolResult {
  const candidate = error as { code?: unknown; message?: unknown };
  const code =
    typeof candidate.code === "string" ? candidate.code : "INTERNAL_ERROR";
  const message =
    typeof candidate.message === "string"
      ? candidate.message
      : "you-brain 操作失败";
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } },
    isError: true,
  };
}

function failureWithDetails(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): ToolResult {
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { error: { code, message }, ...details },
    isError: true,
  };
}

function requireDispatch(services: McpServices): McpDispatchClient {
  if (!services.dispatch) {
    throw Object.assign(new Error("当前环境未连接本机 daemon，无法使用跨设备派活"), {
      code: "DAEMON_NOT_RUNNING",
    });
  }
  return services.dispatch;
}

function resolveByIdOrName<T extends { id: string; name: string }>(
  items: readonly T[],
  query: string,
): { status: "matched"; item: T } | { status: "none" } | { status: "ambiguous"; matches: T[] } {
  const trimmed = query.trim();
  const byId = items.filter((item) => item.id === trimmed);
  if (byId.length === 1) return { status: "matched", item: byId[0]! };
  const lower = trimmed.toLowerCase();
  const byName = items.filter((item) => item.name.trim().toLowerCase() === lower);
  if (byName.length === 1) return { status: "matched", item: byName[0]! };
  if (byName.length > 1) return { status: "ambiguous", matches: byName };
  return { status: "none" };
}

function formatCandidates(items: ReadonlyArray<{ id: string; name: string }>): string {
  if (items.length === 0) return "（无可用候选）";
  return items.map((item) => `${item.name} (${item.id})`).join("、");
}

const UpdateTopicSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("status"),
    topic_id: z.string().min(1),
    status: TopicStatusSchema,
  }),
  z.object({
    action: z.literal("rename"),
    topic_id: z.string().min(1),
    name: z.string().min(1),
    aliases: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    action: z.literal("merge"),
    topic_id: z.string().min(1),
    into_topic_id: z.string().min(1),
  }),
  z.object({
    action: z.literal("split"),
    topic_id: z.string().min(1),
    session_key: SessionKeySchema,
    assign_topic_id: z.string().min(1).optional(),
    create_name: z.string().min(1).optional(),
    create_aliases: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    action: z.literal("todo"),
    topic_id: z.string().min(1),
    todo_id: z.string().min(1),
    status: TodoStatusSchema,
  }),
  z.object({
    action: z.literal("conclusion"),
    topic_id: z.string().min(1),
    text: z.string().min(1),
    session_key: SessionKeySchema,
  }),
]);

const KIND_LABELS: Record<ReferenceKind, string> = {
  tty7: "终端会话",
  session: "会话",
  topic: "话题",
  kb: "知识库",
};

/**
 * 引用候选 → MCP 资源条目。Claude Code 的 @ 菜单左列只显示「服务名:uri」（uri 是编码 id，又会被截断），
 * 右列显示 description；类型和标题放在描述最前面，菜单里才看得出是哪一条，按标题输入 @ 时也能匹配上。
 */
export function referenceResource(item: Pick<ReferenceCandidateView, "kind" | "label" | "detail" | "resourceUri">): {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
} {
  return {
    uri: item.resourceUri,
    name: `${KIND_LABELS[item.kind]} · ${item.label}`,
    description: `【${KIND_LABELS[item.kind]}】${item.label}${item.detail ? ` · ${item.detail}` : ""}`,
    mimeType: "text/markdown",
  };
}

function buildFallbackReferencePorts(services: McpServices): ReferencePorts {
  return {
    today: () => services.getToday(),
    search: (req) => services.searchSessions(req),
    sessionContent: async (input) => {
      const content = await services.getSession({
        source: input.source as SessionSource,
        conversationId: input.conversationId ?? input.sessionKey ?? "",
      });
      return {
        source: content.source,
        conversationId: content.conversationId,
        content: content.content,
        updatedAt: content.updatedAt,
      };
    },
    topics: (query) => services.getTopics(query),
    topic: (topicId) => services.getTopic(topicId).catch(() => null),
    notionSearch: (query, limit) =>
      services.notionSearch({ query, ...(limit !== undefined ? { limit } : {}) }),
    notionPage: (pageId) => services.notionPage({ pageId }).catch(() => null),
  };
}

async function runSearchReferences(
  services: McpServices,
  input: { query?: string; kinds?: ReferenceKind[]; limit?: number },
): Promise<ReferenceCandidatesResponse> {
  if (services.searchReferences) return services.searchReferences(input);
  const candidates = await listReferenceCandidates(input, buildFallbackReferencePorts(services));
  return { candidates };
}

async function runGetReference(
  services: McpServices,
  input: { uri?: string; query?: string; kind?: ReferenceKind },
): Promise<{ content: ReferenceContentView | null; candidates: ReferenceCandidateView[] }> {
  if (services.getReference) return services.getReference(input);
  return resolveReference(input, buildFallbackReferencePorts(services));
}

export function createToolHandlers(services: McpServices) {
  return {
    upload_sessions: async (input: {
      sources?: SessionSource[] | undefined;
      backfill?: boolean | undefined;
      include_subagents?: boolean | undefined;
      dry_run?: boolean | undefined;
    }): Promise<ToolResult> => {
      try {
        const output = await services.uploadSessions({
          ...(input.sources ? { sources: input.sources } : {}),
          ...(input.backfill !== undefined ? { backfill: input.backfill } : {}),
          ...(input.include_subagents !== undefined
            ? { includeSubagents: input.include_subagents }
            : {}),
          ...(input.dry_run !== undefined ? { dryRun: input.dry_run } : {}),
        });
        const scanned = output.scanned;
        const uploaded = output.uploaded;
        return success(output, `扫描 ${scanned} 个会话，上传 ${uploaded} 个。`);
      } catch (error) {
        return failure(error);
      }
    },
    search_sessions: async (input: {
      query: string;
      from?: string | undefined;
      to?: string | undefined;
      sources?: string[] | undefined;
      limit?: number | undefined;
    }): Promise<ToolResult> => {
      try {
        const output = await services.searchSessions({
          query: input.query,
          ...(input.from !== undefined ? { from: input.from } : {}),
          ...(input.to !== undefined ? { to: input.to } : {}),
          ...(input.sources !== undefined ? { sources: input.sources } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
        return success(output, JSON.stringify(output, null, 2));
      } catch (error) {
        return failure(error);
      }
    },
    search_notion: async (input: {
      query: string;
      limit?: number | undefined;
    }): Promise<ToolResult> => {
      try {
        const output = await services.notionSearch({
          query: input.query,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
        const text =
          output.hits.length === 0
            ? `知识库没有匹配「${output.query}」的页面。`
            : output.hits
                .map((hit) => `${hit.title}（${hit.pageId}）\n  ${hit.excerpt.replaceAll("\n", " ")}`)
                .join("\n");
        return success(output, text);
      } catch (error) {
        return failure(error);
      }
    },
    get_notion_page: async (input: {
      page_id: string;
    }): Promise<ToolResult> => {
      try {
        const output = await services.notionPage({ pageId: input.page_id });
        return success(
          { pageId: output.id, title: output.title },
          output.markdown,
        );
      } catch (error) {
        return failure(error);
      }
    },
    get_portrait: async (input: {
      variant?: string | undefined;
      project?: string | undefined;
      full_projects?: boolean | undefined;
    }): Promise<ToolResult> => {
      try {
        const req: GetPortraitMcpInput = {};
        if (input.variant !== undefined) req.variant = input.variant;
        if (input.project !== undefined) req.project = input.project;
        if (input.full_projects !== undefined) req.fullProjects = input.full_projects;
        const output = await services.getPortrait(req);
        const portrait =
          "portrait" in output && typeof output.portrait === "string"
            ? output.portrait
            : "content" in output && typeof output.content === "string"
              ? output.content
              : "画像不可用";
        const structured =
          "portrait" in output
            ? output
            : {
                variant: output.variant,
                portrait: output.content,
                warnings: [],
              };
        return success(structured, portrait);
      } catch (error) {
        return failure(error);
      }
    },
    get_session: async (input: {
      source: SessionSource;
      conversation_id: string;
    }): Promise<ToolResult> => {
      try {
        const output = await services.getSession({
          source: input.source,
          conversationId: input.conversation_id,
        });
        return success(output, output.content);
      } catch (error) {
        return failure(error);
      }
    },
    hub_status: async (): Promise<ToolResult> => {
      try {
        const output = await services.hubStatus();
        return success(output, JSON.stringify(output, null, 2));
      } catch (error) {
        return failure(error);
      }
    },
    get_today: async (): Promise<ToolResult> => {
      try {
        const output = await services.getToday();
        return success(output, JSON.stringify(output, null, 2));
      } catch (error) {
        return failure(error);
      }
    },
    get_topics: async (input: {
      zone?: "active" | "history" | "all" | undefined;
      status?: z.infer<typeof TopicStatusSchema> | undefined;
      limit?: number | undefined;
    }): Promise<ToolResult> => {
      try {
        const query: TopicsQuery = {};
        const effectiveZone = input.zone ?? "active";
        if (effectiveZone !== "all") query.zone = effectiveZone;
        if (input.status !== undefined) query.status = input.status;
        const output = await services.getTopics(query);
        const cap = input.limit ?? 50;
        const sliced =
          output.topics.length > cap
            ? {
                topics: output.topics.slice(0, cap),
                totalCount: output.topics.length,
                truncated: true,
              }
            : output;
        return success(sliced, JSON.stringify(sliced, null, 2));
      } catch (error) {
        return failure(error);
      }
    },
    get_topic: async (input: {
      topic_id: string;
      conclusion_limit?: number | undefined;
      todo_limit?: number | undefined;
      include_closed_todos?: boolean | undefined;
      session_limit?: number | undefined;
    }): Promise<ToolResult> => {
      try {
        const detail = await services.getTopic(input.topic_id);
        const conclusionLimit = input.conclusion_limit ?? 20;
        const todoLimit = input.todo_limit ?? 30;
        const sessionLimit = input.session_limit ?? 15;
        const includeClosed = input.include_closed_todos === true;

        const sortedConclusions = [...detail.conclusions].sort((a, b) =>
          b.ts.localeCompare(a.ts) || a.conclusionId.localeCompare(b.conclusionId),
        );
        const openTodos = detail.todos.filter((todo) => todo.status === "open");
        const candidateTodos = includeClosed ? detail.todos : openTodos;

        const capped = {
          ...detail,
          conclusions: sortedConclusions.slice(0, conclusionLimit),
          todos: candidateTodos.slice(0, todoLimit),
          sessions: detail.sessions.slice(0, sessionLimit),
          counts: {
            conclusionsTotal: detail.conclusions.length,
            openTodosTotal: openTodos.length,
            todosTotal: detail.todos.length,
            sessionsTotal: detail.sessions.length,
          },
        };
        return success(capped, JSON.stringify(capped, null, 2));
      } catch (error) {
        return failure(error);
      }
    },
    update_topic: async (input: UpdateTopicInput): Promise<ToolResult> => {
      try {
        const output = await services.updateTopic(input);
        return success(output, JSON.stringify(output, null, 2));
      } catch (error) {
        return failure(error);
      }
    },
    get_reminders: async (): Promise<ToolResult> => {
      try {
        const output = await services.getReminders();
        return success(output, JSON.stringify(output, null, 2));
      } catch (error) {
        return failure(error);
      }
    },
    add_portrait_correction: async (input: {
      variant?: string | undefined;
      section: string;
      text: string;
    }): Promise<ToolResult> => {
      try {
        const output = await services.addPortraitCorrection({
          section: input.section,
          text: input.text,
          ...(input.variant !== undefined ? { variant: input.variant } : {}),
        });
        return success(
          output,
          "已记录纠正。纠正会在下一次每日沉淀时并入数字分身，不会立刻改写。",
        );
      } catch (error) {
        return failure(error);
      }
    },
    get_portrait_corrections: async (input: {
      variant?: string | undefined;
    }): Promise<ToolResult> => {
      try {
        const output = await services.getPortraitCorrections(
          input.variant !== undefined ? { variant: input.variant } : {},
        );
        return success(output, JSON.stringify(output, null, 2));
      } catch (error) {
        return failure(error);
      }
    },
    search_references: async (input: {
      query?: string | undefined;
      kinds?: ReferenceKind[] | undefined;
      limit?: number | undefined;
    }): Promise<ToolResult> => {
      try {
        const output = await runSearchReferences(services, {
          ...(input.query !== undefined ? { query: input.query } : {}),
          ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
        const text =
          output.candidates.length === 0
            ? "没有找到可引用的候选内容。"
            : output.candidates
                .map((item) => {
                  const header = `[${KIND_LABELS[item.kind]}] ${item.label} — ${item.uri} (${item.resourceUri})`;
                  return item.detail ? `${header}\n  ${item.detail}` : header;
                })
                .join("\n");
        return success(output, text);
      } catch (error) {
        return failure(error);
      }
    },
    get_reference: async (input: {
      uri?: string | undefined;
      query?: string | undefined;
      kind?: ReferenceKind | undefined;
    }): Promise<ToolResult> => {
      try {
        const uri = input.uri?.trim() || undefined;
        const query = input.query?.trim() || undefined;
        if (uri === undefined && query === undefined) {
          return failure(Object.assign(new Error("需要提供 uri 或 query"), { code: "INVALID_INPUT" }));
        }
        const result = await runGetReference(services, {
          ...(uri !== undefined ? { uri } : {}),
          ...(query !== undefined ? { query } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
        });
        if (!result.content) {
          return success(
            { found: false, candidates: result.candidates },
            "没有找到匹配的 U-Brain 引用内容。",
          );
        }
        if (result.content.error !== undefined) {
          return failure(Object.assign(new Error(result.content.error), { code: "SOURCE_UNAVAILABLE" }));
        }
        return success(
          { found: true, reference: result.content, candidates: result.candidates },
          result.content.wrappedText,
        );
      } catch (error) {
        return failure(error);
      }
    },
    list_devices: async (): Promise<ToolResult> => {
      try {
        const dispatch = requireDispatch(services);
        const state = await dispatch.devices();
        const enrolledDevices = state.devices
          .filter((device) => device.enrolled)
          .map((device) => ({
            id: device.id,
            name: device.name,
            online: device.online,
            self: device.self,
            acceptsDispatch: device.dispatch?.enabled === true,
            t3Ready: device.dispatch?.t3.ready === true,
            maxMode: device.dispatch?.maxMode ?? null,
            projects: device.dispatch?.projects ?? [],
          }));
        const output = {
          self: state.self,
          connected: state.connected,
          enrolled: state.enrolled,
          devices: enrolledDevices,
        };
        if (!state.connected && enrolledDevices.length === 0) {
          return success(output, "当前未连接到中转，暂不可见其他设备。");
        }
        if (enrolledDevices.length === 0) {
          return success(output, "当前没有已入网的设备。");
        }
        const lines = enrolledDevices.map((device) => {
          const flags = [
            device.online ? "在线" : "离线",
            device.self ? "本机" : null,
            device.acceptsDispatch ? "接受派活" : "未开启接收派活",
            device.maxMode ? `权限上限:${device.maxMode}` : null,
          ]
            .filter(Boolean)
            .join(" · ");
          const projects =
            device.projects.length > 0
              ? `；可派项目：${device.projects.map((p) => p.name).join("、")}`
              : "；可派项目：无";
          return `- ${device.name} (${device.id}) [${flags}]${projects}`;
        });
        return success(output, lines.join("\n"));
      } catch (error) {
        return failure(error);
      }
    },
    dispatch_to_device: async (input: {
      device: string;
      project: string;
      title: string;
      prompt: string;
      mode?: LaunchModeName | undefined;
    }): Promise<ToolResult> => {
      try {
        const dispatch = requireDispatch(services);
        const state = await dispatch.devices();
        const enrolledDevices = state.devices.filter((device) => device.enrolled);
        const deviceMatch = resolveByIdOrName(enrolledDevices, input.device);
        if (deviceMatch.status === "none") {
          const candidates = enrolledDevices.map((d) => ({
            id: d.id,
            name: d.name,
            online: d.online,
            acceptsDispatch: d.dispatch?.enabled === true,
          }));
          return failureWithDetails(
            "DEVICE_NOT_FOUND",
            `找不到匹配的已入网设备「${input.device}」。可选设备：${formatCandidates(candidates)}`,
            { candidates },
          );
        }
        if (deviceMatch.status === "ambiguous") {
          const candidates = deviceMatch.matches.map((d) => ({
            id: d.id,
            name: d.name,
            online: d.online,
            acceptsDispatch: d.dispatch?.enabled === true,
          }));
          return failureWithDetails(
            "AMBIGUOUS_DEVICE",
            `设备名「${input.device}」匹配到多台设备，请改用设备 ID 重试：${formatCandidates(candidates)}`,
            { candidates },
          );
        }
        const target = deviceMatch.item;
        if (!target.dispatch?.enabled) {
          return failureWithDetails(
            "DISPATCH_DISABLED",
            `目标设备「${target.name}」未开启接收派活`,
            { device: { id: target.id, name: target.name } },
          );
        }
        if (!target.online) {
          return failureWithDetails(
            "DEVICE_OFFLINE",
            `目标设备「${target.name}」当前不在线`,
            { device: { id: target.id, name: target.name } },
          );
        }
        const projects = target.dispatch.projects ?? [];
        const projectMatch = resolveByIdOrName(projects, input.project);
        if (projectMatch.status === "none") {
          return failureWithDetails(
            "PROJECT_NOT_ALLOWED",
            `目标设备「${target.name}」的可派项目列表里没有「${input.project}」。可选项目：${formatCandidates(projects)}`,
            { device: { id: target.id, name: target.name }, candidates: projects },
          );
        }
        if (projectMatch.status === "ambiguous") {
          return failureWithDetails(
            "AMBIGUOUS_PROJECT",
            `项目名「${input.project}」在设备「${target.name}」上匹配到多个项目，请改用项目 ID 重试：${formatCandidates(projectMatch.matches)}`,
            { device: { id: target.id, name: target.name }, candidates: projectMatch.matches },
          );
        }
        const project = projectMatch.item;
        const started = await dispatch.startThread({
          to: target.id,
          projectId: project.id,
          title: input.title,
          prompt: input.prompt,
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
        });
        if (!started.ok) {
          return failureWithDetails("DISPATCH_FAILED", started.error, {
            dispatchId: started.dispatchId,
          });
        }
        const output = {
          dispatchId: started.dispatchId,
          threadId: started.threadId,
          threadUrl: started.threadUrl,
          mode: started.mode,
          capped: started.capped,
          device: { id: target.id, name: target.name },
          project,
        };
        const cappedNote = started.capped ? "（已按对方上限降级）" : "";
        return success(
          output,
          `已派活到「${target.name}」的项目「${project.name}」\ndispatchId: ${started.dispatchId}\nmode: ${started.mode}${cappedNote}\nthreadUrl: ${started.threadUrl}`,
        );
      } catch (error) {
        return failure(error);
      }
    },
    get_dispatch_result: async (input: {
      dispatchId: string;
      refresh?: boolean | undefined;
    }): Promise<ToolResult> => {
      try {
        const dispatch = requireDispatch(services);
        const res = await dispatch.getOutbox(
          input.dispatchId,
          input.refresh !== undefined ? { refresh: input.refresh } : undefined,
        );
        const entry = res.entry;
        const summary = res.read?.summary ?? entry.lastSummary ?? "";
        const errorMessage = res.read?.error ?? entry.error;
        const link = res.read?.link ?? entry.threadUrl ?? null;
        const output = {
          dispatchId: entry.dispatchId,
          status: entry.status,
          deviceName: entry.deviceName,
          title: entry.title,
          mode: entry.mode,
          threadId: entry.threadId ?? null,
          threadUrl: entry.threadUrl ?? null,
          link,
          summary,
          ...(errorMessage !== undefined ? { error: errorMessage } : {}),
          refreshed: res.refreshed,
          ...(res.refreshError !== undefined ? { refreshError: res.refreshError } : {}),
        };
        const parts = [
          `派活任务 ${entry.dispatchId}（${entry.deviceName} · ${entry.title}）`,
          `状态：${entry.status}`,
          ...(link ? [`链接：${link}`] : []),
          ...(errorMessage ? [`错误：${errorMessage}`] : []),
          ...(res.refreshError ? [`刷新失败：${res.refreshError}`] : []),
          ...(summary ? ["", summary] : []),
        ];
        return success(output, parts.join("\n"));
      } catch (error) {
        return failure(error);
      }
    },
    send_to_dispatch: async (input: {
      dispatchId: string;
      message: string;
    }): Promise<ToolResult> => {
      try {
        const dispatch = requireDispatch(services);
        const res = await dispatch.followup(input.dispatchId, { prompt: input.message });
        if (!res.ok) {
          return failureWithDetails("DISPATCH_FAILED", res.error, {
            dispatchId: res.dispatchId,
          });
        }
        return success(res, `已向派活任务 ${res.dispatchId} 发送后续指令。`);
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function createMcpServer(services: McpServices): McpServer {
  const server = new McpServer({ name: "you-brain", version: "0.1.0" });
  const handlers = createToolHandlers(services);
  const source = SessionSourceSchema;

  server.registerTool(
    "upload_sessions",
    {
      description: "扫描、脱敏并增量上传本机 AI 编程会话",
      inputSchema: {
        sources: z.array(source).optional(),
        backfill: z.boolean().optional(),
        include_subagents: z.boolean().optional(),
        dry_run: z.boolean().optional(),
      },
    },
    handlers.upload_sessions,
  );
  server.registerTool(
    "search_sessions",
    {
      description: "用本地索引搜索历史 AI 编程会话",
      inputSchema: {
        query: z.string().min(1),
        from: z.string().optional(),
        to: z.string().optional(),
        sources: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    handlers.search_sessions,
  );
  server.registerTool(
    "search_notion",
    {
      description: "在 Notion 知识库里全文搜索页面,返回标题、页面 ID 和摘要",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    handlers.search_notion,
  );
  server.registerTool(
    "get_notion_page",
    {
      description: "读取一篇 Notion 知识库页面,返回 markdown 正文",
      inputSchema: {
        page_id: z.string().min(1),
      },
    },
    handlers.get_notion_page,
  );
  server.registerTool(
    "get_portrait",
    {
      description:
        "读取本机数字分身。variant 默认 full，也可以是 coding、projects 或自定义变体；variant=\"projects\" 时推荐传 project=\"<仓库目录名或项目名>\" 按需读取单项目口径（省略 project 时返回项目索引）",
      inputSchema: {
        variant: z.string().min(1).optional(),
        project: z.string().min(1).max(120).optional(),
        full_projects: z.boolean().optional(),
      },
    },
    handlers.get_portrait,
  );
  server.registerTool(
    "get_session",
    {
      description: "按来源和会话标识从 Drive inbox 读取完整会话",
      inputSchema: {
        source,
        conversation_id: z.string().min(1),
      },
    },
    handlers.get_session,
  );
  server.registerTool(
    "hub_status",
    {
      description: "读取 you-brain 的运行状态",
      inputSchema: {},
    },
    handlers.hub_status,
  );
  server.registerTool(
    "get_today",
    {
      description: "读取今日会话与提炼",
      inputSchema: {},
    },
    handlers.get_today,
  );
  server.registerTool(
    "get_topics",
    {
      description: "读取话题列表。zone 默认 active（传 history 查历史区，传 all 查全部），默认最多返回 50 个",
      inputSchema: {
        zone: z.enum(["active", "history", "all"]).optional(),
        status: TopicStatusSchema.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    handlers.get_topics,
  );
  server.registerTool(
    "get_topic",
    {
      description:
        "读取一个话题的概要、近期结论、开放待办和会话链接（默认返回最新 20 条结论、30 条开放待办、15 条会话）",
      inputSchema: {
        topic_id: z.string().min(1),
        conclusion_limit: z.number().int().min(1).max(200).optional(),
        todo_limit: z.number().int().min(1).max(200).optional(),
        include_closed_todos: z.boolean().optional(),
        session_limit: z.number().int().min(1).max(100).optional(),
      },
    },
    handlers.get_topic,
  );
  server.registerTool(
    "update_topic",
    {
      description:
        "修改话题。写操作转发给本机 daemon：改状态、改名、合并、拆分、完成或放弃待办、追加结论",
      inputSchema: UpdateTopicSchema,
    },
    handlers.update_topic,
  );
  server.registerTool(
    "get_reminders",
    {
      description: "读取当前应展示的提醒，包括未处理的和已经到期的稍后提醒",
      inputSchema: {},
    },
    handlers.get_reminders,
  );
  server.registerTool(
    "add_portrait_correction",
    {
      description:
        "记录一条数字分身纠正。纠正会在下一次每日沉淀时并入数字分身，不会立刻改写。variant 默认 full",
      inputSchema: {
        variant: z.string().min(1).optional(),
        section: z.string().min(1).max(80),
        text: z.string().min(1).max(1000),
      },
    },
    handlers.add_portrait_correction,
  );
  server.registerTool(
    "get_portrait_corrections",
    {
      description: "读取数字分身纠正及状态。variant 省略时返回全部变体，不会要求 daemon 在线",
      inputSchema: {
        variant: z.string().min(1).optional(),
      },
    },
    handlers.get_portrait_corrections,
  );
  server.registerTool(
    "search_references",
    {
      description:
        "搜索或列出可 @ 引用的 U-Brain 候选内容（tty7 终端会话、今日与历史会话、话题册、Notion 知识库页面）",
      inputSchema: {
        query: z.string().optional(),
        kinds: z.array(ReferenceKindSchema).optional(),
        limit: z.number().int().min(1).max(30).optional(),
      },
    },
    handlers.search_references,
  );
  server.registerTool(
    "get_reference",
    {
      description:
        "按 uri（u-brain-... / you-brain://... / %pane）或 @ 引用关键词读取完整引用正文（支持 终端:/会话:/话题:/知识库: 前缀）",
      inputSchema: {
        uri: z.string().min(1).optional(),
        query: z.string().min(1).optional(),
        kind: ReferenceKindSchema.optional(),
      },
    },
    handlers.get_reference,
  );
  server.registerTool(
    "list_devices",
    {
      description:
        "列出已入网的设备（名称、在线状态、是否接受派活、可派项目列表与权限上限）。派活前先调用此工具确认目标设备和白名单项目",
      inputSchema: {},
    },
    handlers.list_devices,
  );
  server.registerTool(
    "dispatch_to_device",
    {
      description:
        "向另一台开启了接收派活的已入网设备派发一个 T3 任务会话。device 与 project 可传名称或 ID（不猜模糊匹配，只派给对方白名单里的项目），返回 dispatchId、threadUrl 与实际生效权限 mode",
      inputSchema: {
        device: z.string().trim().min(1),
        project: z.string().trim().min(1),
        title: z.string().trim().min(1).max(200),
        prompt: z
          .string()
          .max(60_000)
          .refine((value) => value.trim().length > 0, { message: "任务内容不能为空" }),
        mode: LaunchModeSchema.optional(),
      },
    },
    handlers.dispatch_to_device,
  );
  server.registerTool(
    "get_dispatch_result",
    {
      description:
        "查看一条跨设备派活任务的当前状态（running/waiting/done/failed）与最后一条回答摘要；传 refresh=true 可实时向目标设备刷新",
      inputSchema: {
        dispatchId: z.string().trim().min(1),
        refresh: z.boolean().optional(),
      },
    },
    handlers.get_dispatch_result,
  );
  server.registerTool(
    "send_to_dispatch",
    {
      description: "向一条已发起的跨设备派活任务追加下一条指令（followup）",
      inputSchema: {
        dispatchId: z.string().trim().min(1),
        message: z
          .string()
          .max(60_000)
          .refine((value) => value.trim().length > 0, { message: "消息内容不能为空" }),
      },
    },
    handlers.send_to_dispatch,
  );
  server.registerResource(
    "u-brain-reference",
    new ResourceTemplate("you-brain://{kind}/{id}", {
      list: async () => {
        // Claude Code 只列一次，再自己按输入的字在本地过滤；每类给足 50 条（上限），@ 关键词才搜得到不那么新的条目。
        const res = await runSearchReferences(services, { limit: 50 });
        return {
          resources: res.candidates.map(referenceResource),
        };
      },
      complete: {
        kind: (value) =>
          (["tty7", "session", "topic", "kb"] as const).filter((kind) => kind.startsWith(value)),
      },
    }),
    {
      title: "U-Brain 引用（会话 / 话题 / 知识库 / 终端）",
      description: "通过 @ 在 AI CLI 中直接引用 U-Brain 的会话、话题册、Notion 知识库页面与终端快照",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const resolved = await runGetReference(services, { uri: uri.href });
      if (!resolved.content) {
        throw new Error(`找不到引用资源：${uri.href}`);
      }
      if (resolved.content.error !== undefined) {
        throw new Error(resolved.content.error);
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: resolved.content.wrappedText,
          },
        ],
      };
    },
  );
  return server;
}

export async function serveMcp(services: McpServices): Promise<void> {
  const server = createMcpServer(services);
  await server.connect(new StdioServerTransport());
}
