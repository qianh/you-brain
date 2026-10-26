import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INTERVALS } from "../../src/daemon/schedule.js";
import type { Embedder } from "../../src/search/embedder.js";
import type { LlmBackend } from "../../src/llm/types.js";
import type { StatusResponse } from "../../src/http/types.js";
import { ManualDaemonClock, type YouBrainDaemon } from "../../src/daemon/index.js";

export const CLOCK_START = new Date("2026-10-18T02:00:00.000Z");

export interface DaemonDirs {
  root: string;
  dataDir: string;
  homeDir: string;
  sourceDir: string;
  env: NodeJS.ProcessEnv;
}

export async function makeDaemonDirs(prefix: string): Promise<DaemonDirs> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const dataDir = join(root, "data");
  const homeDir = join(root, "home");
  const sourceDir = join(root, "source");
  await mkdir(sourceDir, { recursive: true });
  return {
    root,
    dataDir,
    homeDir,
    sourceDir,
    env: {
      ...process.env,
      YOU_BRAIN_DATA_DIR: dataDir,
      YOU_BRAIN_HOME: homeDir,
    },
  };
}

export function testClock(): ManualDaemonClock {
  return new ManualDaemonClock(CLOCK_START);
}

/** Avoid loading the E5 model while the daemon refreshes the search index. */
export const throwingEmbedder: Embedder = {
  model: "fake",
  revision: "0",
  dimensions: 8,
  embedQuery() {
    return Promise.reject(new Error("no embedder"));
  },
  embedPassages() {
    return Promise.reject(new Error("no embedder"));
  },
};

export function claudeLine(
  sessionId: string,
  role: "user" | "assistant",
  text: string,
  timestamp: string,
): string {
  const content = role === "user" ? text : [{ type: "text", text }];
  return JSON.stringify({
    type: role,
    isSidechain: false,
    sessionId,
    timestamp,
    message: { role, content },
  });
}

export async function writeClaudeSession(
  sourceDir: string,
  lines: string[],
  name = "session.jsonl",
): Promise<string> {
  const path = join(sourceDir, name);
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

export function refineJson(summary: string): string {
  return JSON.stringify({
    title: "发布清单",
    summary,
    topic: { action: "create", topicId: "", name: "发布流程", aliases: [] },
    conclusions_added: [],
    todos_added: [],
    todos_completed: [],
  });
}

export function fakeBackend(complete: LlmBackend["complete"]): LlmBackend {
  return {
    id: "fake",
    descriptor: {
      provider: "deepseek",
      kind: "openai-compatible",
      model: "fake",
      baseUrl: "http://127.0.0.1",
      jsonMode: "json_object",
      requiresApiKey: false,
    },
    complete,
    test() {
      return Promise.resolve();
    },
  };
}

/**
 * Uploading no longer refines: it only writes the markdown to Drive. A test that wants
 * a topic therefore has to let the refine pass run once.
 */
export async function refineNow(
  clock: ReturnType<typeof testClock>,
  daemon: YouBrainDaemon,
): Promise<void> {
  // Two rounds: the first may land while an earlier pass is still running, in which case
  // the tick skips starting a new one.
  for (let round = 0; round < 2; round += 1) {
    await clock.advance(INTERVALS.refineBackfillMs);
    await daemon.settled();
  }
}

export async function readStatus(daemon: YouBrainDaemon): Promise<StatusResponse> {
  const response = await fetch(`${daemon.baseUrl}/api/status`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as StatusResponse;
}
