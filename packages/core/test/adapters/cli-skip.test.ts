import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { parseClaudeSession } from "../../src/adapters/claude.js";
import { parseCodexSession } from "../../src/adapters/codex.js";
import { parseGeminiSession } from "../../src/adapters/gemini.js";
import { parseGrokSession } from "../../src/adapters/grok.js";
import {
  claudeProjectKey,
  geminiProjectHash,
  physicalPath,
} from "../../src/llm/cli/workdir.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function layout(): Promise<{ root: string; workDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "you-brain-cli-skip-"));
  roots.push(root);
  const workDir = join(root, "llm-cli");
  await mkdir(workDir, { recursive: true });
  return { root, workDir };
}

const options = (workDir: string) => ({
  device: "test-device",
  includeSubagents: false,
  llmCliWorkDir: workDir,
});

describe("subscription CLI sessions are not captured", () => {
  test("claude keeps a normal project and skips the dedicated directory", async () => {
    const { root, workDir } = await layout();
    const physical = physicalPath(workDir);
    const normal = join(root, "projects", "-Users-john-real-project", "session.jsonl");
    const skipped = join(root, "projects", claudeProjectKey(physical), "session.jsonl");
    const body = [
      '{"type":"user","sessionId":"claude-1","timestamp":"2026-07-18T10:00:00.000Z","message":{"role":"user","content":"Review the deployment"}}',
      '{"type":"assistant","sessionId":"claude-1","timestamp":"2026-07-18T10:01:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Use a staged rollout."}]}}',
      "",
    ].join("\n");
    await mkdir(join(normal, ".."), { recursive: true });
    await mkdir(join(skipped, ".."), { recursive: true });
    await writeFile(normal, body);
    await writeFile(skipped, body);
    const kept = await parseClaudeSession(normal, options(workDir));
    const dropped = await parseClaudeSession(skipped, options(workDir));
    expect(kept.session?.conversationId).toBe("claude-1");
    expect(dropped.session).toBeNull();
    expect(dropped.skippedSubagent).toBe(false);
  });

  test("codex keeps a normal cwd and drops the dedicated cwd", async () => {
    const { root, workDir } = await layout();
    const physical = physicalPath(workDir);
    const normal = join(root, "rollout-normal.jsonl");
    const skipped = join(root, "rollout-cli.jsonl");
    const session = (cwd: string) =>
      [
        `{"timestamp":"2026-07-18T11:00:00.000Z","type":"session_meta","payload":{"id":"codex-1","timestamp":"2026-07-18T11:00:00.000Z","cwd":${JSON.stringify(cwd)},"source":"cli"}}`,
        '{"timestamp":"2026-07-18T11:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Find the release issue"}]}}',
        '{"timestamp":"2026-07-18T11:03:00.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Pin the release version."}]}}',
        "",
      ].join("\n");
    await writeFile(normal, session("/home/user/real-project"));
    await writeFile(skipped, session(physical));
    const kept = await parseCodexSession(normal, options(workDir));
    const dropped = await parseCodexSession(skipped, options(workDir));
    expect(kept.session?.source).toBe("codex");
    expect(dropped.session).toBeNull();
    expect(dropped.skippedSubagent).toBe(false);
  });

  test("grok keeps a normal session directory and skips the encoded cwd", async () => {
    const { root, workDir } = await layout();
    const physical = physicalPath(workDir);
    const summary = '{"created_at":"2026-07-18T12:00:00.000Z","updated_at":"2026-07-18T12:03:00.000Z","session_kind":null}\n';
    const history = [
      '{"type":"user","content":[{"type":"text","text":"Compare the options"}]}',
      '{"type":"assistant","content":"Choose the simpler deployment."}',
      "",
    ].join("\n");
    const normal = join(root, "sessions", "normal-project", "session-1");
    const skipped = join(root, "sessions", encodeURIComponent(physical), "session-2");
    for (const dir of [normal, skipped]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "summary.json"), summary);
      await writeFile(join(dir, "chat_history.jsonl"), history);
    }
    const kept = await parseGrokSession(normal, options(workDir));
    const dropped = await parseGrokSession(skipped, options(workDir));
    expect(kept.session?.source).toBe("grok-build");
    expect(dropped.session).toBeNull();
    expect(dropped.skippedSubagent).toBe(false);
  });

  test("gemini keeps another project hash and skips the dedicated hash", async () => {
    const { root, workDir } = await layout();
    const physical = physicalPath(workDir);
    const body = JSON.stringify({
      sessionId: "gemini-1",
      startTime: "2026-07-18T10:00:00.000Z",
      lastUpdated: "2026-07-18T10:05:00.000Z",
      messages: [
        { timestamp: "2026-07-18T10:00:00.000Z", type: "user", content: "List the files" },
        { timestamp: "2026-07-18T10:02:00.000Z", type: "gemini", content: "There are two files." },
      ],
    });
    const normal = join(root, "tmp", "abc123", "chats", "session-normal.json");
    const skipped = join(root, "tmp", geminiProjectHash(physical), "chats", "session-cli.json");
    for (const path of [normal, skipped]) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, body);
    }
    const kept = await parseGeminiSession(normal, options(workDir));
    const dropped = await parseGeminiSession(skipped, options(workDir));
    expect(kept.session?.conversationId).toBe("gemini-1");
    expect(dropped.session).toBeNull();
    expect(dropped.skippedSubagent).toBe(false);
  });
});
