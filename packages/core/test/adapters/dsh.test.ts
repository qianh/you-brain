import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { discoverSessions } from "../../src/adapters/index.js";
import { dshAdapter, dshSessionsRoot, parseDshSession } from "../../src/adapters/dsh.js";
import { createDefaultSharedConfig, parseSharedConfig } from "@you-brain/protocol";

type Ev = Record<string, unknown>;

const T0 = 1_793_685_341_000;

function userEvent(seq: number, text: string, source: Ev = { kind: "user" }, at = T0 + seq * 1000): Ev {
  return { type: "user/message", seq, time: at, data: { content: [{ type: "text", text }], source, role: "user", id: `m${seq}` } };
}

function assistantEvent(seq: number, blocks: Ev[], at = T0 + seq * 1000): Ev {
  return { type: "assistant/message", seq, time: at, data: { turn: 1, step: 1, message: { role: "assistant", content: blocks } } };
}

function sessionLines(events: Ev[], header: Ev = {}): string {
  const head = { type: "session", version: 4, id: "session-x", createdAt: T0, cwd: "/work", isSeeded: false, delegationDepth: 0, ...header };
  return [head, ...events].map((event) => JSON.stringify(event)).join("\n") + "\n";
}

async function writeSession(root: string, id: string, text: string, workspace = "--work--"): Promise<string> {
  const path = join(root, workspace, `session-${id}`, "session.v4.jsonl.zstd");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Bun.zstdCompressSync(new TextEncoder().encode(text)));
  return path;
}

const OPTIONS = { device: "测试机", includeSubagents: false };

describe("dsh session adapter", () => {
  it("keeps real user input and assistant text, drops injected context and tool-only steps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-adapter-"));
    try {
      const path = await writeSession(
        dir,
        "a",
        sessionLines([
          userEvent(1, "什么是费曼学习法"),
          userEvent(2, "Current runtime context…", { kind: "runtime-context", form: "snapshot" }),
          userEvent(3, "<system-reminder>skills…", { kind: "skill-catalog", form: "catalog" }),
          assistantEvent(4, [{ type: "thinking", text: "内部思考不该进入" }, { type: "text", text: "先选一个概念。" }]),
          assistantEvent(5, [{ type: "tool_use", name: "bash" }]),
          assistantEvent(6, [{ type: "text", text: "再讲给外行听。" }]),
          userEvent(7, "谢谢"),
        ]),
      );
      const result = await parseDshSession(path, OPTIONS);
      expect(result.malformedLines).toBe(0);
      expect(result.session).toMatchObject({
        source: "dsh",
        conversationId: "session-a",
        device: "测试机",
        sourcePath: path,
        startedAt: new Date(T0).toISOString(),
      });
      expect(result.session?.turns.map((turn) => [turn.role, turn.text])).toEqual([
        ["user", "什么是费曼学习法"],
        ["assistant", "先选一个概念。\n\n再讲给外行听。"],
        ["user", "谢谢"],
      ]);
      expect(result.session?.updatedAt).toBe(new Date(T0 + 7000).toISOString());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips subagent sessions unless asked, and sessions without any real turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-adapter-"));
    try {
      const child = await writeSession(dir, "child", sessionLines([userEvent(1, "子任务"), assistantEvent(2, [{ type: "text", text: "完成" }])], { delegationDepth: 1 }));
      expect(await parseDshSession(child, OPTIONS)).toMatchObject({ session: null, skippedSubagent: true });
      expect((await parseDshSession(child, { ...OPTIONS, includeSubagents: true })).session?.turns).toHaveLength(2);
      const empty = await writeSession(dir, "empty", sessionLines([userEvent(1, "ctx", { kind: "runtime-context" })]));
      expect(await parseDshSession(empty, OPTIONS)).toMatchObject({ session: null, skippedSubagent: false, malformedLines: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a half-written file as retryable, and tolerates bad lines and appended frames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-adapter-"));
    try {
      const text = sessionLines([userEvent(1, "你好"), assistantEvent(2, [{ type: "text", text: "你好呀" }])]);
      const full = await writeSession(dir, "full", text);
      const compressed = Bun.zstdCompressSync(new TextEncoder().encode(text));
      const truncated = join(dir, "--work--", "session-trunc", "session.v4.jsonl.zstd");
      await mkdir(dirname(truncated), { recursive: true });
      await writeFile(truncated, compressed.slice(0, compressed.length - 8));
      expect(await parseDshSession(truncated, OPTIONS)).toMatchObject({ session: null, malformedLines: 1 });
      // 追加写入的多帧文件：两段各自压缩后拼接。
      const first = Bun.zstdCompressSync(new TextEncoder().encode(sessionLines([userEvent(1, "你好")])));
      const second = Bun.zstdCompressSync(new TextEncoder().encode(JSON.stringify(assistantEvent(2, [{ type: "text", text: "你好呀" }])) + "\nnot json\n"));
      const multi = join(dir, "--work--", "session-multi", "session.v4.jsonl.zstd");
      await mkdir(dirname(multi), { recursive: true });
      await writeFile(multi, Buffer.concat([first, second]));
      expect((await parseDshSession(multi, OPTIONS)).session?.turns.map((turn) => turn.text)).toEqual(["你好", "你好呀"]);
      expect((await parseDshSession(full, OPTIONS)).session?.turns).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("discovers sessions across workspaces and ignores other files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-adapter-"));
    try {
      const a = await writeSession(dir, "a", sessionLines([userEvent(1, "A")]), "--ws1--");
      const b = await writeSession(dir, "b", sessionLines([userEvent(1, "B")]), "--ws2--");
      await writeFile(join(dir, "--ws1--", "session-a", "session.lock"), "");
      await mkdir(join(dir, "--ws1--", "not-a-session"), { recursive: true });
      const found: string[] = [];
      for await (const file of dshAdapter.discover([dir, join(dir, "missing")])) found.push(file.path);
      expect(found.sort()).toEqual([a, b].sort());
      const scanned = await discoverSessions({
        device: "测试机",
        includeSubagents: false,
        sources: ["dsh"],
        paths: { claude: [], codex: [], grok: [], cursor: [], dsh: [dir] },
      });
      expect(scanned.sessions.map((session) => session.conversationId).sort()).toEqual(["session-a", "session-b"]);
      expect(scanned.status.dsh).toMatchObject({ discovered: 2, captured: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the default root sits under the data dir", () => {
    expect(dshSessionsRoot("/data")).toBe("/data/deck/dsh/home/sessions");
  });

  it("an older shared config without the dsh source still loads and gets the default", () => {
    const legacy = JSON.parse(JSON.stringify(createDefaultSharedConfig())) as { capture: { sources: Record<string, unknown> } };
    delete legacy.capture.sources.dsh;
    const parsed = parseSharedConfig(legacy);
    expect(parsed.capture.sources.dsh).toEqual({ enabled: true, paths: [], include: [], exclude: [] });
    // 用户已有的其它来源设置不受影响。
    legacy.capture.sources.codex = { enabled: false, paths: ["/x"], include: [], exclude: [] };
    expect(parseSharedConfig(legacy).capture.sources.codex.enabled).toBe(false);
  });
});
