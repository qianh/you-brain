import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";
import { createEvent, ulid, type Event } from "@you-brain/protocol";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import type { LlmBackend } from "../../src/llm/types.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { foldEvents } from "../../src/topics/fold.js";
import { persistTopicBook } from "../../src/topics/persist.js";
import { fakeBackend, makeDaemonDirs, testClock, type DaemonDirs } from "./helpers.js";

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const OLD = "2026-01-01T00:00:00.000Z";
let seq = 0;

function created(topicId: string, name: string): Event {
  seq += 1;
  return createEvent({
    type: "topic.created",
    id: ulid(Date.parse(OLD) + seq),
    ts: OLD,
    device: "seed-device",
    seq,
    data: { topicId, name, aliases: [] },
  });
}

async function seed(dirs: DaemonDirs): Promise<void> {
  await mkdir(dirs.dataDir, { recursive: true });
  const store = new SqliteStore(join(dirs.dataDir, "state.sqlite"));
  persistTopicBook(
    store,
    foldEvents([created("a", "港口目录接入"), created("b", "港口目录复核"), created("c", "无关话题")]),
  );
  store.close();
}

async function boot(llm: LlmBackend, extra: Record<string, unknown> = {}): Promise<YouBrainDaemon> {
  const dirs = await makeDaemonDirs("you-brain-reorganize-");
  roots.push(dirs.root);
  await seed(dirs);
  const daemon = await startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname: "test-host",
    clock: testClock(),
    sourceRoots: {},
    watch: false,
    signals: false,
    llm,
    ...extra,
  });
  started.push(daemon);
  await daemon.settled();
  return daemon;
}

async function post(daemon: YouBrainDaemon, path: string, body: unknown): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function topicNames(daemon: YouBrainDaemon): Promise<string[]> {
  const response = await fetch(`${daemon.baseUrl}/api/topics`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  const { topics } = (await response.json()) as { topics: { name: string; zone: string }[] };
  return topics.map((topic) => `${topic.name}:${topic.zone}`).sort();
}

/** Group the two port topics by finding them in the prompt, whatever order they are listed in. */
function groupingBackend(): LlmBackend & { calls: () => number } {
  let calls = 0;
  const backend = fakeBackend(async (request) => {
    calls += 1;
    const index = (name: string): number =>
      Number(request.user.split("\n").find((line) => line.includes(name))?.split("｜")[0] ?? -1);
    return JSON.stringify({
      groups: [{ name: "港口目录", reason: "同一个项目", topics: [index("接入"), index("复核")] }],
      noise: [],
    });
  });
  return Object.assign(backend, { calls: () => calls });
}

describe.each([
  ["without Drive", () => ({})],
  ["with Drive", () => ({ drive: new MemoryDrive() })],
])("topic reorganize %s", (_label, extra) => {
  it("plans once, reuses the plan, applies it, and leaves merged topics out of the active zone", async () => {
    const llm = groupingBackend();
    const daemon = await boot(llm, extra());

    const plan = (await (await post(daemon, "/api/actions/topics-reorganize/plan", {})).json()) as {
      topicCount: number;
      topicCountAfter: number;
      groups: { name: string; intoTopicId: string; members: { topicId: string }[]; archive: boolean }[];
    };
    expect(plan.topicCount).toBe(3);
    expect(plan.topicCountAfter).toBe(2);
    expect(plan.groups).toHaveLength(1);

    await post(daemon, "/api/actions/topics-reorganize/plan", {});
    expect(llm.calls()).toBe(1);
    await post(daemon, "/api/actions/topics-reorganize/plan", { refresh: true });
    expect(llm.calls()).toBe(2);

    const group = plan.groups[0];
    if (!group) throw new Error("expected a group");
    const applied = await post(daemon, "/api/actions/topics-reorganize/apply", {
      groups: [
        {
          intoTopicId: group.intoTopicId,
          fromTopicIds: group.members.slice(1).map((member) => member.topicId),
          name: group.name,
          archive: group.archive,
        },
      ],
    });
    expect(await applied.json()).toEqual({ merged: 1 });

    const names = await topicNames(daemon);
    expect(names).toContain("港口目录:history");
    expect(names).toContain("无关话题:history");
    expect(names).toHaveLength(2);

    await post(daemon, "/api/actions/topics-reorganize/plan", {});
    expect(llm.calls()).toBe(3);
  }, 30_000);

  it("forgets a failed plan so the next attempt starts over", async () => {
    let calls = 0;
    const daemon = await boot(
      fakeBackend(async () => {
        calls += 1;
        return "不是 JSON";
      }),
      extra(),
    );
    const failed = await post(daemon, "/api/actions/topics-reorganize/plan", {});
    expect(failed.ok).toBe(false);
    expect(calls).toBe(2);
    await post(daemon, "/api/actions/topics-reorganize/plan", {});
    expect(calls).toBe(4);
  }, 30_000);
});
