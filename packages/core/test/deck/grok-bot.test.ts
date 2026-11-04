import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { grokBotTurns, parseGrokBotBlob } from "../../src/adapters/grok-bot.js";

const opts = { device: "测试机" };

describe("grok bot blob parser", () => {
  it("extracts turns from a transcript blob", () => {
    const value = {
      entries: [
        { kind: "message", role: "user", content: "帮我查 X 上的 AI 新闻", timestampMs: 1788700828578 },
        { kind: "send-message", message: "{'type':'text'}", timestampMs: 1 },
        { kind: "message", role: "assistant", content: "以下是三条新闻", timestampMs: 1788700835613 },
      ],
      persistedAt: 1788700900000,
    };
    const turns = grokBotTurns(value);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: "user", text: "帮我查 X 上的 AI 新闻" });
    expect(turns[1]).toMatchObject({ role: "assistant", text: "以下是三条新闻" });
  });

  it("treats the bot's text send-message entries as assistant turns", () => {
    const turns = grokBotTurns({
      entries: [
        { kind: "message", role: "user", content: "问题", timestampMs: 1000 },
        { kind: "send-message", message: { type: "text", content: "回答" }, timestampMs: 2000 },
        { kind: "send-message", message: { type: "text", content: "带引用", reply_to: "x" }, timestampMs: 3000 },
        { kind: "send-message", message: { type: "image", url: "a.png" }, timestampMs: 4000 },
        { kind: "send-message", message: "{'type':'text'}", timestampMs: 5000 },
      ],
    });
    expect(turns).toEqual([
      { role: "user", text: "问题", atMs: 1000 },
      { role: "assistant", text: "回答", atMs: 2000 },
      { role: "assistant", text: "带引用", atMs: 3000 },
    ]);
  });

  it("ignores UI-state blobs", () => {
    expect(
      grokBotTurns({ sidebar: { expandedWidth: 240 }, infoPane: { isOpen: false } }),
    ).toEqual([]);
    expect(grokBotTurns(null)).toEqual([]);
    expect(grokBotTurns({ records: [{ input: { prompt: "hi" } }] })).toEqual([]);
  });

  it("parses a transcript blob file into a session and skips a UI blob", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbot-"));
    try {
      const transcript = {
        schemaVersion: 1,
        value: {
          entries: [
            { kind: "message", role: "user", content: "早上好", timestampMs: 1788700828578 },
            { kind: "message", role: "assistant", content: "早", timestampMs: 1788700835613 },
          ],
          persistedAt: 1788700900000,
        },
      };
      const path = join(dir, "thread-a.blob");
      await writeFile(path, JSON.stringify(transcript), "utf8");
      const result = await parseGrokBotBlob(path, opts);
      expect(result.session).not.toBeNull();
      expect(result.session?.source).toBe("grok-bot");
      expect(result.session?.conversationId).toBe("thread-a");
      expect(result.session?.turns).toHaveLength(2);
      expect(
        (result.session?.updatedAt ?? "") >= (result.session?.startedAt ?? ""),
      ).toBe(true);

      const ui = join(dir, "ui-state.blob");
      await writeFile(
        ui,
        JSON.stringify({ schemaVersion: 3, value: { sidebar: { expandedWidth: 240 } } }),
        "utf8",
      );
      const skipped = await parseGrokBotBlob(ui, opts);
      expect(skipped.session).toBeNull();
      expect(skipped.skippedNoise).toBeFalsy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not crash on a malformed blob", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbot-"));
    try {
      const path = join(dir, "broken.blob");
      await writeFile(path, "{not json", "utf8");
      const result = await parseGrokBotBlob(path, opts);
      expect(result.session).toBeNull();
      expect(result.malformedLines).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
