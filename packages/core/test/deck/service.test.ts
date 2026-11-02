import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmBackend } from "../../src/llm/types.js";
import type { UploadableSession } from "../../src/upload/types.js";
import { DeckService } from "../../src/deck/service.js";
import type { DeckCapabilityPort } from "../../src/deck/capabilities.js";

function fakeBackend(reply: (system: string, user: string) => string): LlmBackend {
  return {
    id: "fake",
    descriptor: {
      provider: "claude-cli",
      kind: "cli",
      model: "",
      baseUrl: "",
      jsonMode: "json_schema",
      requiresApiKey: false,
    },
    complete: async (request) => reply(request.system, request.user),
    test: async () => undefined,
  };
}

const capabilities: DeckCapabilityPort = {
  today: async () => "今天没有会话",
  activeTopics: async () => "- 测试话题（进行中）[topic-1]：概要",
  topic: async () => "（话题不存在）",
  search: async () => "（没有匹配的会话）",
  portrait: async () => "数字分身 full：测试内容",
  knowledge: async () => "（知识库没有匹配页面）",
};

interface Harness {
  service: DeckService;
  dir: string;
  uploads: UploadableSession[];
  agents: Array<{ provider: string; prompt: string }>;
  changes: number;
}

async function harness(masterReply: (system: string, user: string) => string): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "deck-"));
  const uploads: UploadableSession[] = [];
  const agents: Array<{ provider: string; prompt: string }> = [];
  let changes = 0;
  const service = new DeckService({
    dataDir: dir,
    displayName: "测试机",
    homeDir: dir,
    timeZone: "Asia/Shanghai",
    capabilities,
    upload: async (session) => {
      uploads.push(session);
    },
    driveAvailable: () => true,
    llmSelection: () => ({ provider: "deepseek", model: "", baseUrl: "" }),
    emitChange: () => {
      changes += 1;
    },
    runAgent: async (options) => {
      agents.push({ provider: options.provider, prompt: options.prompt });
      return "agent 干完了";
    },
    createMasterBackend: async () => fakeBackend(masterReply),
    createModelBackend: async () => fakeBackend(() => "模型输出"),
    probeExecutors: false,
  });
  return { service, dir, uploads, agents, changes };
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

describe("deck service", () => {
  it("answers inline and uploads the session", async () => {
    const h = await harness(() => '{"kind":"answer","text":"今天没有会话"}');
    try {
      const conversation = await h.service.send("今天做了什么", null);
      expect(conversation.turns).toHaveLength(2);
      expect(conversation.turns[1]?.text).toBe("今天没有会话");
      expect(h.uploads).toHaveLength(1);
      expect(h.uploads[0]?.source).toBe("deck");
      expect(h.uploads[0]?.markdown).toContain("## User");
      expect(h.uploads[0]?.markdown).toContain("## Assistant");
    } finally {
      await cleanup(h.dir);
    }
  });

  it("dispatches to a cli agent in the background and records the result", async () => {
    const h = await harness(
      () =>
        '{"kind":"dispatch","title":"写首诗","executor":{"kind":"cli-agent","id":"claude-cli"},"prompt":"写一首关于秋天的诗"}',
    );
    try {
      const conversation = await h.service.send("让 agent 写首诗", null);
      expect(conversation.turns.some((turn) => turn.role === "event" && turn.text.includes("已派活"))).toBe(true);
      await h.service.settled();
      const done = await h.service.getConversation(conversation.id);
      expect(done?.turns.some((turn) => turn.text.includes("agent 干完了"))).toBe(true);
      expect(h.agents).toHaveLength(1);
      expect(h.agents[0]?.provider).toBe("claude-cli");
      expect(h.agents[0]?.prompt).toContain("写一首关于秋天的诗");
      // 任务 workdir 落在 deck/agent-work 下。
      const persisted = await readFile(
        join(h.dir, "deck", "conversations", `${conversation.id}.json`),
        "utf8",
      );
      expect(persisted).toContain("agent 干完了");
      // 会话原文在结果落地后又上传了一次（原地更新）。
      expect(h.uploads.length).toBeGreaterThanOrEqual(2);
    } finally {
      await cleanup(h.dir);
    }
  });

  it("registers a schedule from a schedule decision", async () => {
    const h = await harness(
      () =>
        '{"kind":"schedule","title":"每日早报","executor":{"kind":"capability","id":"today"},"prompt":"汇总","schedule":{"kind":"daily","time":"08:00"}}',
    );
    try {
      const conversation = await h.service.send("每天八点给我早报", null);
      expect(conversation.turns.some((turn) => turn.text.includes("已登记周期任务"))).toBe(true);
      const tasks = await h.service.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.schedule).toEqual({ kind: "daily", time: "08:00" });
    } finally {
      await cleanup(h.dir);
    }
  });

  it("falls back to answer when the master returns prose", async () => {
    const h = await harness(() => "这是一个直接回答。");
    try {
      const conversation = await h.service.send("你好", null);
      expect(conversation.turns[1]?.role).toBe("assistant");
      expect(conversation.turns[1]?.text).toBe("这是一个直接回答。");
    } finally {
      await cleanup(h.dir);
    }
  });

  it("runs a due task on tick and stamps lastRunAt", async () => {
    const h = await harness(
      () =>
        '{"kind":"schedule","title":"搜索汇总","executor":{"kind":"capability","id":"search"},"prompt":"AI 新闻","schedule":{"kind":"interval","minutes":5}}',
    );
    try {
      await h.service.send("每5分钟搜一次", null);
      const [task] = await h.service.listTasks();
      expect(task).toBeDefined();
      await h.service.tick(Date.now());
      await h.service.settled();
      const refreshed = (await h.service.listTasks())[0];
      expect(refreshed?.lastRunAt).not.toBeNull();
      expect(refreshed?.lastStatus).toBe("ok");
      const conversation = await h.service.getConversation(`task-${task?.id}`);
      expect(conversation?.turns.some((turn) => turn.text.includes("没有匹配的会话"))).toBe(true);
      // 再 tick 一次：间隔未到，不再执行。
      const before = refreshed?.lastRunAt;
      await h.service.tick(Date.now());
      await h.service.settled();
      expect(((await h.service.listTasks())[0])?.lastRunAt).toBe(before);
    } finally {
      await cleanup(h.dir);
    }
  });
});
