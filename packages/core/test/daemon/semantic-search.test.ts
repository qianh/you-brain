import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { resolveDaemonEmbedder } from "../../src/daemon/daemon.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import type { Embedder } from "../../src/search/embedder.js";
import { makeDaemonDirs, testClock, type DaemonDirs } from "./helpers.js";

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("semantic search switch", () => {
  it("does not construct an embedder when semantic search is off", () => {
    let opened = 0;
    const injected: Embedder = {
      model: "injected",
      revision: "v1",
      dimensions: 3,
      embedQuery() {
        return Promise.resolve([1, 0, 0]);
      },
      embedPassages(texts) {
        return Promise.resolve(texts.map(() => [1, 0, 0]));
      },
    };

    expect(
      resolveDaemonEmbedder({
        semantic: false,
        injected,
        openDefault() {
          opened += 1;
          return injected;
        },
      }),
    ).toBeNull();
    expect(opened).toBe(0);
    expect(
      resolveDaemonEmbedder({
        semantic: true,
        injected,
        openDefault() {
          opened += 1;
          return injected;
        },
      }),
    ).toBe(injected);
    expect(opened).toBe(0);
    expect(
      resolveDaemonEmbedder({
        semantic: true,
        openDefault() {
          opened += 1;
          return injected;
        },
      }),
    ).toBe(injected);
    expect(opened).toBe(1);
  });

  it("does not call the embedder after semantic search is turned off", async () => {
    const dirs = await dirsFor("you-brain-semantic-off-");
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    await drive.put({
      path: "inbox/mac/codex.md",
      bytes: Buffer.from(`---
source: codex
conversation_id: semantic-off
started_at: 2026-07-18T01:00:00.000Z
updated_at: 2026-07-18T02:00:00.000Z
content_sha256: ${"a".repeat(64)}
---
## User
rollback checklist
`),
      mimeType: "text/markdown",
    });
    let calls = 0;
    const embedder: Embedder = {
      model: "counting",
      revision: "v1",
      dimensions: 3,
      embedQuery() {
        calls += 1;
        return Promise.resolve([1, 0, 0]);
      },
      embedPassages(texts) {
        calls += texts.length;
        return Promise.resolve(texts.map(() => [1, 0, 0]));
      },
    };
    const daemon = await start(dirs, { clock, drive, embedder, sourceRoots: {} });
    await clock.advance(60_000);
    expect(calls).toBeGreaterThan(0);

    calls = 0;
    const put = await fetch(`${daemon.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ search: { semantic: false } }),
    });
    expect(put.ok).toBe(true);
    await clock.advance(60_000);
    const result = await fetch(`${daemon.baseUrl}/api/search?q=rollback`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    const body = (await result.json()) as {
      searchMode: string;
      warnings: Array<{ code: string }>;
      results: Array<{ conversationId: string }>;
    };

    expect(calls).toBe(0);
    expect(body.searchMode).toBe("keyword");
    expect(body.warnings).toEqual([]);
    expect(body.results[0]?.conversationId).toBe("semantic-off");
  });
});

async function dirsFor(prefix: string): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs(prefix);
  roots.push(dirs.root);
  await mkdir(dirs.dataDir, { recursive: true });
  await writeFile(
    join(dirs.dataDir, "shared.json"),
    `${JSON.stringify({ capture: { sources: { "claude-code": { enabled: false }, codex: { enabled: false }, "grok-build": { enabled: false }, cursor: { enabled: false }, "gemini-cli": { enabled: false } } } })}\n`,
  );
  return dirs;
}

function start(
  dirs: DaemonDirs,
  extra: Parameters<typeof startDaemon>[0],
): Promise<YouBrainDaemon> {
  return startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname: "device-a",
    clock: testClock(),
    llm: null,
    watch: false,
    signals: false,
    ...extra,
  }).then(async (daemon) => {
    started.push(daemon);
    await daemon.settled();
    return daemon;
  });
}
