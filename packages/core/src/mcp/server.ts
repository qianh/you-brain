import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TodoStatusSchema, TopicStatusSchema } from "@you-brain/protocol";
import { z } from "zod";

import {
  SessionSourceSchema,
  type SessionSource,
} from "../domain/session.js";

import type {
  ActionResponse,
  PortraitCorrectionResult,
  PortraitCorrectionsResponse,
  PortraitResponse,
  RemindersResponse,
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

export interface McpServices {
  searchSessions(input: SearchRequest & { limit?: number }): Promise<SearchResponse>;
  getSession(input: {
    source: SessionSource;
    conversationId: string;
  }): Promise<SessionContent>;
  getPortrait(input: { variant?: string }): Promise<PortraitContent | PortraitResponse>;
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
    get_portrait: async (input: {
      variant?: string | undefined;
    }): Promise<ToolResult> => {
      try {
        const output = await services.getPortrait(
          input.variant !== undefined ? { variant: input.variant } : {},
        );
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
      zone?: "active" | "history" | undefined;
      status?: z.infer<typeof TopicStatusSchema> | undefined;
    }): Promise<ToolResult> => {
      try {
        const query: TopicsQuery = {};
        if (input.zone !== undefined) query.zone = input.zone;
        if (input.status !== undefined) query.status = input.status;
        const output = await services.getTopics(query);
        return success(output, JSON.stringify(output, null, 2));
      } catch (error) {
        return failure(error);
      }
    },
    get_topic: async (input: { topic_id: string }): Promise<ToolResult> => {
      try {
        const output = await services.getTopic(input.topic_id);
        return success(output, JSON.stringify(output, null, 2));
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
    "get_portrait",
    {
      description: "读取本机数字分身。variant 默认 full，也可以是 brief、coding 或自定义变体",
      inputSchema: {
        variant: z.string().min(1).optional(),
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
      description: "读取话题列表，可按活跃区、历史区或状态过滤",
      inputSchema: {
        zone: z.enum(["active", "history"]).optional(),
        status: TopicStatusSchema.optional(),
      },
    },
    handlers.get_topics,
  );
  server.registerTool(
    "get_topic",
    {
      description: "读取一个话题的概要、结论、待办和会话链接",
      inputSchema: {
        topic_id: z.string().min(1),
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
  return server;
}

export async function serveMcp(services: McpServices): Promise<void> {
  const server = createMcpServer(services);
  await server.connect(new StdioServerTransport());
}
