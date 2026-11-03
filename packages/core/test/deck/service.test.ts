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

/** 流式版假后端：把回复拆成小块，经 completeStream 的累计回调吐出。 */
function fakeStreamBackend(reply: (system: string, user: string) => string): LlmBackend {
  const base = fakeBackend(reply);
  return {
    ...base,
    completeStream: async (request, onDelta) => {
      const text = reply(request.system, request.user);
      let raw = "";
      for (let i = 0; i < text.length; i += 4) {
        raw = text.slice(0, i + 4);
        onDelta(raw);
      }
      onDelta(text);
      return text;
    },
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
  deltas: Array<{ conversationId: string; text: string }>;
}

async function harness(
  masterReply: (system: string, user: string) => string,
  options?: { stream?: boolean },
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "deck-"));
  const uploads: UploadableSession[] = [];
  const agents: Array<{ provider: string; prompt: string }> = [];
  const deltas: Array<{ conversationId: string; text: string }> = [];
  let changes = 0;
  let tick = 0;
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
    // nowMs 每次调用前进 300ms，绕过 250ms 的增量节流，测试能收齐每条 delta。
    clock: { now: () => new Date(), nowMs: () => (tick += 300) },
    emitDeckDelta: (conversationId, text) => {
      deltas.push({ conversationId, text });
    },
    runAgent: async (options) => {
      agents.push({ provider: options.provider, prompt: options.prompt });
      return "agent 干完了";
    },
    createMasterBackend: async () =>
      options?.stream === true ? fakeStreamBackend(masterReply) : fakeBackend(masterReply),
    createModelBackend: async () => fakeBackend(() => "模型输出"),
    probeExecutors: false,
  });
  return { service, dir, uploads, agents, changes, deltas };
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
      await h.service.settled();
      // 用户轮、回答轮各上传一次（原地更新同一会话原文）。
      expect(h.uploads.length).toBeGreaterThanOrEqual(2);
      expect(h.uploads[0]?.source).toBe("deck");
      const finalUpload = h.uploads[h.uploads.length - 1];
      expect(finalUpload?.markdown).toContain("## User");
      expect(finalUpload?.markdown).toContain("## Assistant");
    } finally {
      await cleanup(h.dir);
    }
  });

  it("beginSend returns after the user turn; the answer lands in the background", async () => {
    const h = await harness(() => '{"kind":"answer","text":"后台落地的回答"}');
    try {
      const conversation = await h.service.beginSend("问题", null);
      expect(conversation.turns).toHaveLength(1);
      expect(conversation.turns[0]?.role).toBe("user");
      const listed = await h.service.listConversations();
      expect(listed.some((item) => item.id === conversation.id)).toBe(true);
      await h.service.settled();
      const done = await h.service.getConversation(conversation.id);
      expect(done?.turns).toHaveLength(2);
      expect(done?.turns[1]?.role).toBe("assistant");
      expect(done?.turns[1]?.text).toBe("后台落地的回答");
    } finally {
      await cleanup(h.dir);
    }
  });

  it("records a master failure as an event turn instead of throwing", async () => {
    const h = await harness(() => {
      throw new Error("没有可用的本机 CLI 作为主控");
    });
    try {
      const conversation = await h.service.send("你好", null);
      expect(
        conversation.turns.some((turn) => turn.role === "event" && turn.text.includes("【主控 · 失败】")),
      ).toBe(true);
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

  it("streams answer deltas through emitDeckDelta while the master runs", async () => {
    const h = await harness(() => '{"kind":"answer","text":"流式落地的回答"}', { stream: true });
    try {
      const conversation = await h.service.send("问题", null);
      expect(conversation.turns).toHaveLength(2);
      // 流式增量按累计文本到达，最后一条就是完整回答。
      expect(h.deltas.length).toBeGreaterThanOrEqual(2);
      expect(h.deltas[0]?.conversationId).toBe(conversation.id);
      expect(h.deltas[h.deltas.length - 1]?.text).toBe("流式落地的回答");
    } finally {
      await cleanup(h.dir);
    }
  });

  it("deletes a conversation", async () => {
    const h = await harness(() => '{"kind":"answer","text":"好的"}');
    try {
      const conversation = await h.service.send("你好", null);
      expect(await h.service.deleteConversation(conversation.id)).toBe(true);
      expect(await h.service.getConversation(conversation.id)).toBeNull();
      const listed = await h.service.listConversations();
      expect(listed.some((item) => item.id === conversation.id)).toBe(false);
      expect(await h.service.deleteConversation(conversation.id)).toBe(false);
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
