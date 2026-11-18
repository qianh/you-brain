import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { createDaemonClient } from "../../src/http/client.js";
import type { DeckHttpPort, HttpDeps } from "../../src/http/deps.js";
import { startDaemonHttp, type DaemonHttpServer } from "../../src/http/server.js";

async function withServer(
  run: (server: DaemonHttpServer, outputDir: string) => Promise<void>,
  overrides: Partial<HttpDeps> = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "you-brain-http-ref-"));
  const outputDir = join(dir, "output");
  const deck = {
    tty7Sessions: async () => ({
      available: true,
      detail: "",
      workspaces: [{ id: "ws-1", name: "dev", attached: true }],
      sessions: [
        {
          pane: 140,
          workspaceId: "ws-1",
          workspaceName: "dev",
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
    tty7Screen: async (pane: number) => ({ pane, text: "screen line 1\nscreen line 2" }),
  } as unknown as DeckHttpPort;

  const deps = {
    outputDir,
    deck,
    today: async () => ({
      date: "2026-11-18",
      timeZone: "Asia/Shanghai",
      sessions: [
        {
          sessionKey: "a".repeat(64),
          source: "codex",
          device: "mac",
          fileId: null,
          title: "Magpie 最佳实践",
          summary: "路由总结",
          startedAt: "2026-11-18T08:00:00Z",
          updatedAt: "2026-11-18T09:00:00Z",
          msgCount: 4,
          refinedUpTo: 4,
          topicId: "topic-1",
          topicName: "T3 引用",
          conclusions: [],
          todos: [],
        },
      ],
    }),
    search: async (req) => ({
      query: req.query,
      indexStatus: "fresh",
      searchMode: "keyword",
      results: [],
      warnings: [],
    }),
    sessionContent: async (input) => ({
      source: input.source,
      conversationId: input.conversationId ?? input.sessionKey ?? "",
      content: "# Magpie 最佳实践\n\n详细对话内容",
      updatedAt: "2026-11-18T09:00:00Z",
    }),
    topics: async () => ({
      topics: [
        {
          topicId: "topic-1",
          name: "T3 引用",
          aliases: ["T3"],
          status: "active",
          statusBy: "auto",
          summary: "支持在 T3 和 CLI 中引用",
          nextStep: "",
          lastActive: "2026-11-18T09:00:00Z",
          zone: "active",
          createdTs: "2026-11-18T00:00:00Z",
          lastUserOpAt: null,
          userLocked: false,
          openTodoCount: 0,
        },
      ],
    }),
    topic: async (id) =>
      id === "topic-1"
        ? {
            topicId: "topic-1",
            name: "T3 引用",
            aliases: ["T3"],
            status: "active",
            statusBy: "auto",
            summary: "支持在 T3 和 CLI 中引用",
            nextStep: "",
            lastActive: "2026-11-18T09:00:00Z",
            zone: "active",
            mergedInto: null,
            createdTs: "2026-11-18T00:00:00Z",
            lastUserOpAt: null,
            userLocked: false,
            conclusions: [],
            todos: [],
            sessions: [],
          }
        : null,
    notionRecent: async () => [
      { pageId: "kb-1", title: "影之刃零攻略.md", lastEditedTime: "2026-11-18T08:00:00Z" },
    ],
    notionSearch: async (query) => ({
      query,
      hits: [
        { pageId: "kb-2", title: "法务合同比对", excerpt: "核对清单" },
      ].filter((hit) => hit.title.includes(query) || hit.excerpt.includes(query)),
    }),
    notionPage: async (pageId) =>
      pageId === "kb-missing"
        ? null
        : {
            id: pageId,
            title: pageId === "kb-2" ? "法务合同比对" : "影之刃零攻略.md",
            icon: null,
            coverUrl: null,
            lastEditedTime: "2026-11-18T08:00:00Z",
            blocks: [],
            markdown: "# 正文\n\n内容",
          },
    ...overrides,
  } as HttpDeps;

  const server = await startDaemonHttp({ dataDir: dir, deps });
  try {
    await run(server, outputDir);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("HTTP /api/references/*", () => {
  it("lists candidates, reads content, and materializes to disk", async () => {
    await withServer(async (server, outputDir) => {
      const client = createDaemonClient({ port: server.port, token: server.token });
      const empty = await client.referenceCandidates();
      expect(empty.candidates.map((item) => item.kind)).toEqual(["tty7", "session", "topic", "kb"]);

      const filtered = await client.referenceCandidates({ query: "合同", kinds: ["kb"], limit: 5 });
      expect(filtered.candidates).toHaveLength(1);
      expect(filtered.candidates[0]?.label).toBe("法务合同比对");

      const content = await client.referenceContent({ uri: filtered.candidates[0]!.uri });
      expect(content.kind).toBe("kb");
      expect(content.text).toContain("# 正文");

      const materialized = await client.materializeReference({
        uri: filtered.candidates[0]!.uri,
        label: filtered.candidates[0]!.label,
      });
      expect(materialized.ok).toBe(true);
      expect(materialized.fileMention).toBe(`@${materialized.path}`);
      expect(materialized.path.startsWith(join(outputDir, "references"))).toBe(true);
      expect(readFileSync(materialized.path, "utf8")).toContain("# 正文");
    });
  });

  it("validates params and refuses to materialize error payloads", async () => {
    await withServer(async (server, outputDir) => {
      const auth = { authorization: `Bearer ${server.token}` };
      expect((await fetch(`${server.baseUrl}/api/references/candidates?kinds=invalid`, { headers: auth })).status).toBe(400);
      expect((await fetch(`${server.baseUrl}/api/references/candidates?limit=99`, { headers: auth })).status).toBe(400);
      expect((await fetch(`${server.baseUrl}/api/references/content`, { headers: auth })).status).toBe(400);
      expect((await fetch(`${server.baseUrl}/api/references/content?q=完全不存在的词`, { headers: auth })).status).toBe(404);

      const missingId = Buffer.from(JSON.stringify({ pageId: "kb-missing" }), "utf8").toString("base64url");
      const matRes = await fetch(`${server.baseUrl}/api/references/materialize`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ kind: "kb", id: missingId }),
      });
      expect(matRes.status).toBe(404);
      expect(existsSync(join(outputDir, "references"))).toBe(false);
    });
  });
});
