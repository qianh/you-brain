import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mock, describe, expect, it } from "bun:test";

import { createMcpServer, createToolHandlers, type McpServices } from "../../src/mcp/server.js";

const TOOLS = [
  "add_portrait_correction",
  "get_portrait",
  "get_portrait_corrections",
  "get_reminders",
  "get_session",
  "get_today",
  "get_topic",
  "get_topics",
  "hub_status",
  "search_sessions",
  "update_topic",
  "upload_sessions",
];

function services(): McpServices & {
  uploadSessions: ReturnType<typeof mock>;
  searchSessions: ReturnType<typeof mock>;
  getPortrait: ReturnType<typeof mock>;
  getSession: ReturnType<typeof mock>;
  getReminders: ReturnType<typeof mock>;
  addPortraitCorrection: ReturnType<typeof mock>;
  getPortraitCorrections: ReturnType<typeof mock>;
} {
  const uploadSessions = mock(async () => ({
    dryRun: true,
    scanned: 2,
    uploaded: 1,
    warnings: [],
  }));
  const searchSessions = mock(async () => ({
    query: "release",
    indexStatus: "fresh" as const,
    searchMode: "keyword" as const,
    results: [],
    warnings: [],
  }));
  const getPortrait = mock(async () => ({
    variant: "full",
    portrait: "profile",
    warnings: [],
  }));
  const getSession = mock(async () => ({
    source: "codex" as const,
    conversationId: "session-1",
    content: "complete session",
    updatedAt: "2026-07-20T00:00:00.000Z",
  }));
  return {
    uploadSessions,
    searchSessions,
    getPortrait,
    getSession,
    hubStatus: async () => ({ drive: { reachable: true }, warnings: [] }),
    getToday: async () => ({ date: "2026-07-20", timeZone: "UTC", sessions: [] }),
    getTopics: async () => ({ topics: [] }),
    getTopic: async () => {
      throw Object.assign(new Error("missing"), { code: "NOT_FOUND" });
    },
    updateTopic: async () => ({ ok: true as const, topicId: "topic-1", events: [] }),
    getReminders: mock(async () => ({ reminders: [] })),
    addPortraitCorrection: mock(async () => ({
      ok: true as const,
      correction: {
        correctionId: "corr-1",
        variant: "full",
        section: "语气",
        text: "改短",
        createdAt: "2026-07-20T00:00:00.000Z",
        status: "pending" as const,
      },
    })),
    getPortraitCorrections: mock(async () => ({ corrections: [] })),
  };
}

function textOf(result: { [key: string]: unknown }): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  const block = content[0] as { text?: unknown } | undefined;
  return typeof block?.text === "string" ? block.text : "";
}

describe("MCP tool handlers", () => {
  it("exposes the you-brain tools and keeps BrainHub argument names", async () => {
    const runtime = services();
    const handlers = createToolHandlers(runtime);
    expect(Object.keys(handlers).sort()).toEqual(TOOLS);
    const upload = await handlers.upload_sessions({
      sources: ["cursor"],
      dry_run: true,
      include_subagents: false,
      backfill: true,
    });
    expect(upload.structuredContent).toMatchObject({ dryRun: true, scanned: 2, uploaded: 1 });
    expect(textOf(upload)).toContain("2");
    expect(textOf(upload)).toContain("1");
    expect(runtime.uploadSessions).toHaveBeenCalledWith({
      sources: ["cursor"],
      dryRun: true,
      includeSubagents: false,
      backfill: true,
    });
    await handlers.search_sessions({ query: "release", limit: 5, from: "2026-01-01" });
    expect(runtime.searchSessions).toHaveBeenCalledWith({
      query: "release",
      limit: 5,
      from: "2026-01-01",
    });
    const portrait = await handlers.get_portrait({ variant: "coding" });
    expect(textOf(portrait)).toBe("profile");
    expect(runtime.getPortrait).toHaveBeenCalledWith({ variant: "coding" });
    const session = await handlers.get_session({
      source: "codex",
      conversation_id: "session-1",
    });
    expect(textOf(session)).toBe("complete session");
    expect(runtime.getSession).toHaveBeenCalledWith({
      source: "codex",
      conversationId: "session-1",
    });
    expect((await handlers.get_reminders()).structuredContent).toEqual({ reminders: [] });
    expect(runtime.getReminders).toHaveBeenCalled();
    const today = await handlers.get_today();
    expect(today.structuredContent).toMatchObject({ date: "2026-07-20" });
    expect((await handlers.get_topics({ zone: "history", status: "done" })).isError).not.toBe(
      true,
    );
    const missing = await handlers.get_topic({ topic_id: "missing" });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toEqual({
      error: { code: "NOT_FOUND", message: "missing" },
    });
    const updated = await handlers.update_topic({
      action: "status",
      topic_id: "topic-1",
      status: "parked",
    });
    expect(updated.isError).not.toBe(true);
  });

  it("returns the reminder payload from the service", async () => {
    const runtime = services();
    runtime.getReminders.mockImplementation(async () => ({
      reminders: [
        {
          reminderId: "morning:2026-10-21",
          kind: "morning_digest",
          topicId: null,
          topicName: null,
          text: "早报",
          status: "open",
          until: null,
          issuedAt: "2026-10-21T00:00:00.000Z",
        },
      ],
    }));
    const handlers = createToolHandlers(runtime);
    const result = await handlers.get_reminders();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      reminders: [{ reminderId: "morning:2026-10-21", text: "早报" }],
    });
  });

  it("maps domain errors without leaking a stack", async () => {
    const runtime = services();
    runtime.uploadSessions.mockImplementation(async () => {
      throw Object.assign(new Error("login needed"), { code: "AUTH_REQUIRED" });
    });
    const result = await createToolHandlers(runtime).upload_sessions({});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: "AUTH_REQUIRED", message: "login needed" },
    });
    expect(textOf(result)).not.toContain("at ");
  });

  it("returns complete portrait and session content without truncation", async () => {
    const portrait = `# Portrait\n${"p".repeat(70_000)}`;
    const session = `# Session\n${"s".repeat(70_000)}`;
    const runtime = services();
    runtime.getPortrait.mockImplementation(async () => ({
      variant: "full",
      portrait,
      warnings: [],
    }));
    runtime.getSession.mockImplementation(async () => ({
      source: "codex" as const,
      conversationId: "session-1",
      content: session,
      updatedAt: "2026-07-20T00:00:00.000Z",
    }));
    const handlers = createToolHandlers(runtime);
    expect(textOf(await handlers.get_portrait({}))).toBe(portrait);
    expect(
      textOf(
        await handlers.get_session({ source: "codex", conversation_id: "session-1" }),
      ),
    ).toBe(session);
  });
});

describe("portrait correction tools", () => {
  it("returns the saved correction and surfaces service failures", async () => {
    const runtime = services();
    const handlers = createToolHandlers(runtime);
    const added = await handlers.add_portrait_correction({ section: "语气", text: "改短" });
    expect(added.isError).not.toBe(true);
    expect(added.structuredContent).toMatchObject({
      ok: true,
      correction: { correctionId: "corr-1", status: "pending" },
    });
    expect(textOf(added)).toContain("不会立刻改写");

    runtime.addPortraitCorrection.mockImplementation(async () => {
      throw Object.assign(new Error("无效的数字分身变体"), { code: "INVALID_INPUT" });
    });
    const rejected = await handlers.add_portrait_correction({
      variant: "nope",
      section: "语气",
      text: "改短",
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent).toEqual({
      error: { code: "INVALID_INPUT", message: "无效的数字分身变体" },
    });

    runtime.getPortraitCorrections.mockImplementation(async () => ({
      corrections: [
        {
          correctionId: "corr-1",
          variant: "full",
          section: "语气",
          text: "改短",
          createdAt: "2026-07-20T00:00:00.000Z",
          status: "pending",
        },
      ],
    }));
    const listed = await handlers.get_portrait_corrections({ variant: "full" });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      corrections: [{ correctionId: "corr-1", status: "pending" }],
    });

    runtime.getPortraitCorrections.mockImplementation(async () => {
      throw Object.assign(new Error("读失败"), { code: "INTERNAL_ERROR" });
    });
    const failed = await handlers.get_portrait_corrections({});
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toEqual({
      error: { code: "INTERNAL_ERROR", message: "读失败" },
    });
    expect(textOf(failed)).not.toContain("at ");
  });
});

describe("MCP protocol", () => {
  it("negotiates every tool and validates arguments", async () => {
    const runtime = services();
    const server = createMcpServer(runtime);
    const client = new Client({ name: "you-brain-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(TOOLS);
      const sessionTool = tools.tools.find((tool) => tool.name === "get_session");
      expect(sessionTool?.inputSchema).toMatchObject({
        required: ["source", "conversation_id"],
      });
      const portraitTool = tools.tools.find((tool) => tool.name === "get_portrait");
      expect(portraitTool?.inputSchema.properties).toHaveProperty("variant");
      const invalid = await client.callTool({
        name: "search_sessions",
        arguments: { query: "" },
      });
      expect(invalid.isError).toBe(true);
      expect(textOf(invalid)).toContain("Input validation error");
      const upload = await client.callTool({
        name: "upload_sessions",
        arguments: { sources: ["cursor"], dry_run: true },
      });
      expect(upload.isError).not.toBe(true);
      expect(runtime.uploadSessions).toHaveBeenCalledWith({
        sources: ["cursor"],
        dryRun: true,
      });
      const reminders = await client.callTool({ name: "get_reminders", arguments: {} });
      expect(reminders.isError).not.toBe(true);
      expect(reminders.structuredContent).toEqual({ reminders: [] });
      const added = await client.callTool({
        name: "add_portrait_correction",
        arguments: { section: "语气", text: "改短" },
      });
      expect(added.isError).not.toBe(true);
      expect(textOf(added)).toContain("不会立刻改写");
      expect(runtime.addPortraitCorrection).toHaveBeenCalledWith({ section: "语气", text: "改短" });
      const emptySection = await client.callTool({
        name: "add_portrait_correction",
        arguments: { section: "", text: "改短" },
      });
      expect(emptySection.isError).toBe(true);
      const listed = await client.callTool({
        name: "get_portrait_corrections",
        arguments: { variant: "full" },
      });
      expect(listed.isError).not.toBe(true);
      expect(runtime.getPortraitCorrections).toHaveBeenCalledWith({ variant: "full" });
      const update = await client.callTool({
        name: "update_topic",
        arguments: { action: "conclusion", topic_id: "topic-1", text: "记下", session_key: "ab".repeat(32) },
      });
      expect(update.isError).not.toBe(true);
      const badUpdate = await client.callTool({
        name: "update_topic",
        arguments: { action: "status", topic_id: "topic-1" },
      });
      expect(badUpdate.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
