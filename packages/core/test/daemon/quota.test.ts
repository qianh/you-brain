import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { tokenWindowCutoffs } from "../../src/quota/usage-log.js";
import type { QuotaView } from "../../src/quota/types.js";
import { CLOCK_START, makeDaemonDirs, testClock } from "./helpers.js";

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const OUTPUT = JSON.stringify([
  {
    agent: "claude",
    user: "someone@example.com",
    plan: "pro",
    active: true,
    windows: [{ name: "5 hours", used: 31, remaining: 69, resetsAt: "2026-11-17T00:10:00+08:00" }],
  },
]);

/** Request-log fixture built from the test clock, so bucketing holds in any timezone. */
async function writeUsageLog(homeDir: string): Promise<void> {
  const cuts = tokenWindowCutoffs(CLOCK_START.getTime());
  const row = (t: number, tokens: [number, number, number]): string =>
    JSON.stringify({ t: new Date(t).toISOString(), agent: "codex", in: tokens[0], out: tokens[1], cache_read: tokens[2] });
  const dir = join(homeDir, ".config", "magpie");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "usage.jsonl"),
    `${[row(cuts.today + 3_600_000, [100, 10, 1000]), row(cuts.threeDays + 3_600_000, [200, 20, 2000]), row(cuts.sevenDays + 3_600_000, [300, 30, 3000])].join("\n")}\n`,
  );
}

async function boot(magpie: string | null): Promise<YouBrainDaemon> {
  const dirs = await makeDaemonDirs("you-brain-quota-");
  roots.push(dirs.root);
  let bin = "/nonexistent/magpie";
  if (magpie !== null) {
    bin = join(dirs.root, "magpie");
    await writeFile(bin, `#!/bin/sh\n${magpie}\n`);
    await chmod(bin, 0o755);
  }
  await writeUsageLog(dirs.homeDir);
  const daemon = await startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: { ...dirs.env, YOU_BRAIN_MAGPIE_BIN: bin },
    hostname: "test-host",
    clock: testClock(),
    sourceRoots: {},
    watch: false,
    signals: false,
    llm: null,
  });
  started.push(daemon);
  await daemon.settled();
  return daemon;
}

async function quota(daemon: YouBrainDaemon): Promise<QuotaView> {
  const response = await fetch(`${daemon.baseUrl}/api/quota`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as QuotaView;
}

async function untilRead(daemon: YouBrainDaemon): Promise<QuotaView> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const view = await quota(daemon);
    if (view.readAt !== null) return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("quota never loaded");
}

describe("GET /api/quota", () => {
  it("answers at once with nothing, then serves what magpie printed, without the email", async () => {
    const daemon = await boot(`sleep 0.2; echo '2026/11/16 plugin: host starts'; echo '${OUTPUT}'`);
    const first = await quota(daemon);
    expect(first).toEqual({ accounts: [], tokens: {}, readAt: null, stale: false });
    const view = await untilRead(daemon);
    expect(view.accounts.map(({ id: _id, readAt: _readAt, ...rest }) => rest)).toEqual([
      {
        agent: "claude",
        plan: "pro",
        active: true,
        windows: [{ name: "5 hours", used: 31, resetsAt: "2026-11-17T00:10:00+08:00" }],
        stale: false,
      },
    ]);
    expect(view.tokens.codex?.today).toEqual({ calls: 1, input: 100, output: 10, cacheRead: 1000, total: 1110 });
    expect(view.tokens.codex?.threeDays).toEqual({ calls: 2, input: 300, output: 30, cacheRead: 3000, total: 3330 });
    expect(view.tokens.codex?.sevenDays).toEqual({ calls: 3, input: 600, output: 60, cacheRead: 6000, total: 6660 });
    expect(JSON.stringify(view)).not.toContain("example.com");
  });

  it("is an empty list, not an error, when magpie is not installed", async () => {
    const daemon = await boot(null);
    await quota(daemon);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await quota(daemon)).toEqual({ accounts: [], tokens: {}, readAt: null, stale: false });
  });

  it("is an empty list when magpie exits with an error", async () => {
    const daemon = await boot("echo boom >&2; exit 3");
    await quota(daemon);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await quota(daemon)).toEqual({ accounts: [], tokens: {}, readAt: null, stale: false });
  });
});
