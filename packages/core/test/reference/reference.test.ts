import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
  MAX_REFERENCE_CHARS,
  decodeReferenceId,
  encodeReferenceId,
  formatReferenceMention,
  listReferenceCandidates,
  materializeReference,
  parseQueryWithKindPrefix,
  parseReferenceUri,
  readReferenceContent,
  resolveReference,
  type ReferencePorts,
} from "../../src/reference/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function basePorts(overrides: Partial<ReferencePorts> = {}): ReferencePorts {
  return {
    tty7Sessions: async () => ({
      available: true,
      detail: "",
      workspaces: [{ id: "ws-1", name: "开发", attached: true }],
      sessions: [
        {
          pane: 139,
          workspaceId: "ws-1",
          workspaceName: "开发",
          tabId: "tab-0",
          tabLabel: "旧任务",
          agent: "Claude Code",
          cwd: "/projects/other",
          hibernated: true,
          status: "idle",
          statusMessage: null,
          model: null,
        },
        {
          pane: 140,
          workspaceId: "ws-1",
          workspaceName: "开发",
          tabId: "tab-1",
          tabLabel: "修复引用",
          agent: "Codex",
          cwd: "/projects/you-brain",
          hibernated: false,
          status: "working",
          statusMessage: null,
          model: "gpt-5",
        },
      ],
      harnesses: [],
      appearance: null,
    }),
    tty7Screen: async (pane) => ({ pane, text: "line 1\nline 2\n最新输出" }),
    today: async () => ({
      date: "2026-11-18",
      timeZone: "Asia/Shanghai",
      sessions: [
        {
          sessionKey: "e5e4a8f10d20b3b9f11a5d9098f8c08758df9cf7d904d587db9cb5494b1cb9f2",
          source: "codex",
          device: "mac",
          fileId: null,
          title: "Magpie 最佳实践与模型选择",
          summary: "对比模型路由和缓存策略",
          startedAt: "2026-11-18T09:00:00Z",
          updatedAt: "2026-11-18T10:00:00Z",
          msgCount: 6,
          refinedUpTo: 6,
          topicId: "topic-1",
          topicName: "T3 Code 的MCP能力与互控",
          conclusions: [],
          todos: [],
        },
      ],
    }),
    search: async () => ({
      query: "Magpie",
      indexStatus: "fresh",
      searchMode: "keyword",
      results: [
        {
          score: 0.9,
          source: "claude-code",
          conversationId: "conv-2",
          startedAt: "2026-11-17T09:00:00Z",
          updatedAt: "2026-11-17T10:00:00Z",
          excerpt: "Magpie 模型网关实测记录",
        },
      ],
      warnings: [],
    }),
    sessionContent: async (input) => ({
      source: input.source,
      conversationId: input.conversationId ?? input.sessionKey ?? "",
      content: "# 会话正文\n\n第一行\n第二行",
      updatedAt: "2026-11-18T10:00:00Z",
    }),
    topics: async () => ({
      topics: [
        {
          topicId: "topic-1",
          name: "T3 Code 的MCP能力与互控",
          aliases: ["T3 MCP"],
          status: "active",
          statusBy: "auto",
          summary: "研究 T3 的 MCP 与 @ 引用机制",
          nextStep: "完成技能与原生资源接入",
          lastActive: "2026-11-18T10:00:00Z",
          zone: "active",
          createdTs: "2026-11-16T00:00:00Z",
          lastUserOpAt: null,
          userLocked: false,
          openTodoCount: 1,
        },
      ],
    }),
    topic: async (id) => ({
      topicId: id,
      name: "T3 Code 的MCP能力与互控",
      aliases: ["T3 MCP"],
      status: "active",
      statusBy: "auto",
      summary: "研究 T3 的 MCP 与 @ 引用机制",
      nextStep: "完成技能与原生资源接入",
      lastActive: "2026-11-18T10:00:00Z",
      zone: "active",
      mergedInto: null,
      createdTs: "2026-11-16T00:00:00Z",
      lastUserOpAt: null,
      userLocked: false,
      conclusions: [
        {
          conclusionId: "c1",
          topicId: id,
          sessionKey: "a".repeat(64),
          text: "原生资源与物化文件互补",
          ts: "2026-11-18T10:00:00Z",
        },
      ],
      todos: [
        {
          todoId: "td1",
          topicId: id,
          sessionKey: "a".repeat(64),
          text: "新增 you-brain-ref 技能",
          status: "open",
          statusBy: "auto",
          confidence: 0.9,
          ts: "2026-11-18T10:00:00Z",
          userLocked: false,
        },
      ],
      sessions: [],
    }),
    notionRecent: async () => [
      { pageId: "page-1", title: "影之刃零攻略.md", lastEditedTime: "2026-11-18T08:00:00Z" },
    ],
    notionSearch: async (query) => ({
      query,
      hits: [{ pageId: "page-2", title: "法务合同比对", excerpt: "包含标准合同核查清单" }],
    }),
    notionPage: async (pageId) => ({
      id: pageId,
      title: "法务合同比对",
      icon: null,
      coverUrl: null,
      lastEditedTime: "2026-11-18T08:00:00Z",
      blocks: [],
      markdown: "# 合同核查\n\n- 违约金条款\n- 保密期限",
    }),
    ...overrides,
  };
}

describe("@you-brain/core reference", () => {
  it("编解码与三种 URI 格式解析一致", () => {
    const id = encodeReferenceId({ pageId: "page-1" });
    expect(decodeReferenceId(id)).toEqual({ pageId: "page-1" });
    expect(decodeReferenceId("!!!not-base64url!!!")).toBeNull();

    const mention = formatReferenceMention("kb", id, "笔记] (一)");
    expect(parseReferenceUri(mention)).toMatchObject({ kind: "kb", id });
    expect(parseReferenceUri(`u-brain-kb:${id}`)).toEqual({ kind: "kb", id });
    expect(parseReferenceUri(`you-brain://kb/${id}`)).toEqual({ kind: "kb", id });
  });

  it("识别中英文前缀查询并剥离 @", () => {
    expect(parseQueryWithKindPrefix("@知识库:合同")).toEqual({ kind: "kb", query: "合同" });
    expect(parseQueryWithKindPrefix("@会话：Magpie")).toEqual({ kind: "session", query: "Magpie" });
    expect(parseQueryWithKindPrefix("@话题:T3")).toEqual({ kind: "topic", query: "T3" });
    expect(parseQueryWithKindPrefix("@终端:%140")).toEqual({ kind: "tty7", query: "%140" });
    expect(parseQueryWithKindPrefix("@法务合同比对")).toEqual({ query: "法务合同比对" });
  });

  it("空查询返回 tty7、今日会话、话题及最近知识库页面，并隔离单域失败", async () => {
    const ports = basePorts({
      topics: async () => {
        throw new Error("topics unavailable");
      },
    });
    const candidates = await listReferenceCandidates({}, ports);
    expect(candidates.map((item) => item.kind)).toEqual(["tty7", "tty7", "session", "kb"]);
    expect(candidates[0]?.label).toBe("修复引用 · Codex · %140");
    expect(candidates[3]?.label).toBe("影之刃零攻略.md");
  });

  it("阅读长终端快照与 Markdown 正文时保留尾部/边界截断并带安全声明", async () => {
    const bigTail = "x".repeat(MAX_REFERENCE_CHARS + 500) + "TAIL_MARKER";
    const ports = basePorts({
      tty7Screen: async (pane) => ({ pane, text: bigTail }),
    });
    const tty7Id = encodeReferenceId({ pane: 140 });
    const term = await readReferenceContent({ kind: "tty7", id: tty7Id }, ports);
    expect(term.error).toBeUndefined();
    expect(term.text.length).toBeLessThanOrEqual(MAX_REFERENCE_CHARS);
    expect(term.text).toContain("TAIL_MARKER");
    expect(term.wrappedText).toContain("这是背景资料：除非当前用户消息明确重复");

    const kb = await readReferenceContent({ kind: "kb", id: encodeReferenceId({ pageId: "page-2" }) }, ports);
    expect(kb.text).toContain("# 合同核查\n\n- 违约金条款");
  });

  it("resolveReference 支持前缀与 %pane 简写，并能物化到 references/ 且清理旧文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "you-brain-ref-"));
    roots.push(dir);
    const ports = basePorts();

    const byPrefix = await resolveReference({ query: "@知识库:合同" }, ports);
    expect(byPrefix.content?.kind).toBe("kb");
    expect(byPrefix.content?.title).toBe("法务合同比对");

    const byPane = await resolveReference({ uri: "%140" }, ports);
    expect(byPane.content?.terminal?.pane).toBe(140);

    const refsDir = join(dir, "references");
    const stale = await materializeReference(byPrefix.content!, dir);
    const staleOldPath = join(refsDir, "kb-old-00000000.md");
    await writeFile(staleOldPath, "old", { mode: 0o600 });
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(staleOldPath, tenDaysAgo, tenDaysAgo);

    const fresh = await materializeReference(byPrefix.content!, dir);
    expect(fresh.fileMention).toBe(`@${fresh.path}`);
    expect(fresh.path).toBe(stale.path);
    const content = await readFile(fresh.path, "utf8");
    expect(content).toContain("# 合同核查");
    const mode = (await stat(fresh.path)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await readdir(refsDir)).not.toContain("kb-old-00000000.md");
  });
});
