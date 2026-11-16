import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import type { LlmCompleteRequest } from "../../src/llm/types.js";
import { RECALL_SYSTEM_PROMPT } from "../../src/recall/index.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { foldEvents } from "../../src/topics/fold.js";
import { persistTopicBook } from "../../src/topics/persist.js";
import { buildEvent, sessionKey } from "../topics/helpers.js";
import {
  CLOCK_START,
  claudeLine,
  fakeBackend,
  makeDaemonDirs,
  refineJson,
  testClock,
  throwingEmbedder,
  writeClaudeSession,
  type DaemonDirs,
} from "./helpers.js";

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const TOPIC = "topic-release";
const SAY = JSON.stringify({
  say: true,
  grade: "important",
  text: "10-10 你留了一条：补发布清单里的回滚步骤，还没做。",
  basisId: "todo:todo-rollback",
});

/** 一个已有的话题，带一条开放待办，开会话前就在库里。 */
async function seedTopic(dirs: DaemonDirs): Promise<void> {
  await mkdir(dirs.dataDir, { recursive: true });
  const store = new SqliteStore(join(dirs.dataDir, "state.sqlite"));
  let seq = 0;
  const at = "2026-10-10T02:00:00.000Z";
  persistTopicBook(
    store,
    foldEvents([
      buildEvent<"topic.created">({ type: "topic.created", device: "seed", ts: at, seq: ++seq, data: { topicId: TOPIC, name: "发布流程", aliases: ["发布"] } }),
      buildEvent<"todo.added">({ type: "todo.added", device: "seed", ts: at, seq: ++seq, data: { todoId: "todo-rollback", topicId: TOPIC, text: "补发布清单里的回滚步骤", sessionKey: sessionKey(1), confidence: 0.9 } }),
    ]),
  );
  store.close();
}

interface Booted {
  daemon: YouBrainDaemon;
  dirs: DaemonDirs;
  clock: ReturnType<typeof testClock>;
  drive: MemoryDrive;
  recallCalls: LlmCompleteRequest[];
}

async function boot(
  options: {
    recallReply?: () => string;
    before?: (dirs: DaemonDirs, drive: MemoryDrive) => Promise<void>;
  } = {},
): Promise<Booted> {
  const dirs = await makeDaemonDirs("you-brain-recall-");
  roots.push(dirs.root);
  await seedTopic(dirs);
  const clock = testClock();
  const drive = new MemoryDrive({ now: () => clock.now() });
  await options.before?.(dirs, drive);
  const recallCalls: LlmCompleteRequest[] = [];
  const llm = fakeBackend(async (request) => {
    if (request.system === RECALL_SYSTEM_PROMPT) {
      recallCalls.push(request);
      return (options.recallReply ?? (() => SAY))();
    }
    return refineJson("讨论了发布");
  });
  const daemon = await startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname: "device-a",
    clock,
    drive,
    llm,
    embedder: throwingEmbedder,
    sourceRoots: { "claude-code": [dirs.sourceDir] },
    watch: false,
    signals: false,
  });
  started.push(daemon);
  await daemon.settled();
  return { daemon, dirs, clock, drive, recallCalls };
}

async function reminders(daemon: YouBrainDaemon): Promise<Array<{ kind: string; topicId: string | null; text: string }>> {
  const response = await fetch(`${daemon.baseUrl}/api/reminders`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  if (!response.ok) throw new Error(await response.text());
  return ((await response.json()) as { reminders: Array<{ kind: string; topicId: string | null; text: string }> })
    .reminders;
}

async function tickOnce(booted: Booted): Promise<void> {
  await booted.clock.advance(1_000);
  await booted.daemon.settled();
}

const NOW_ISO = CLOCK_START.toISOString();

/**
 * 设备要先成为主设备，才会收集网页会话；之后网页文件被当作新变化重新报出，再被索引。
 * `roles` 里写 webProcessor 就把网页会话交给别的设备。
 */
async function receiveWebSession(booted: Booted, id: string, roles: Record<string, unknown>): Promise<void> {
  const headers = { authorization: `Bearer ${booted.daemon.token}` };
  const status = (await fetch(`${booted.daemon.baseUrl}/api/status`, { headers }).then((r) => r.json())) as {
    deviceId: string;
  };
  const put = await fetch(`${booted.daemon.baseUrl}/api/roles`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ mainDevice: status.deviceId, ...roles }),
  });
  if (!put.ok) throw new Error(await put.text());
  await booted.clock.advance(60_000);
  await booted.drive.put({
    path: `inbox/web-chatgpt/2026/10/${id}.md`,
    bytes: webFile(id, new Date(booted.clock.nowMs()).toISOString()),
    mimeType: "text/markdown",
  });
  await booted.clock.advance(60_000);
  await booted.daemon.settled();
  for (let round = 0; round < 3; round += 1) await tickOnce(booted);
}

function webFile(id: string, updatedAt: string): Buffer {
  return Buffer.from(
    [
      "---",
      "source: chatgpt",
      `conversation_id: ${id}`,
      "device: browser",
      "started_at: 2026-10-18T01:00:00.000Z",
      `updated_at: ${updatedAt}`,
      "---",
      "",
      "## User",
      "",
      "发布流程这次要改成每周发布",
      "",
      "## Assistant",
      "",
      "好的",
      "",
    ].join("\n"),
  );
}

describe("daemon recall reminders", () => {
  it("新会话聊到有开放待办的话题时发出 recall 提醒", async () => {
    const booted = await boot({
      before: async (dirs) => {
        await writeClaudeSession(dirs.sourceDir, [
          claudeLine("recall-1", "user", "发布流程这次要改成每周发布，先把清单理一下", NOW_ISO),
        ]);
      },
    });
    await tickOnce(booted);
    const items = (await reminders(booted.daemon)).filter((item) => item.kind.startsWith("recall"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "recall", topicId: TOPIC, text: "10-10 你留了一条：补发布清单里的回滚步骤，还没做。" });
    expect(booted.recallCalls).toHaveLength(1);
    const log = await readFile(join(booted.dirs.dataDir, "recall-log.jsonl"), "utf8");
    expect(JSON.parse(log.trim().split("\n").at(-1) as string)).toMatchObject({ outcome: "issued", grade: "important" });
  });

  it("启动时扫到的旧会话（更新于 10 分钟前）不触发任何模型调用", async () => {
    const booted = await boot({
      before: async (dirs) => {
        for (let n = 0; n < 50; n += 1) {
          await writeClaudeSession(
            dirs.sourceDir,
            [claudeLine(`old-${n}`, "user", "发布流程这次要改成每周发布", "2026-10-18T01:00:00.000Z")],
            `old-${n}.jsonl`,
          );
        }
      },
    });
    await tickOnce(booted);
    expect(booted.recallCalls).toHaveLength(0);
    expect((await reminders(booted.daemon)).filter((item) => item.kind.startsWith("recall"))).toHaveLength(0);
  });

  it("关闭通知时不调用模型", async () => {
    const booted = await boot();
    // 对照：开着时，新会话会调用模型。
    await writeClaudeSession(booted.dirs.sourceDir, [
      claudeLine("recall-on", "user", "发布流程这次要改成每周发布", NOW_ISO),
    ], "on.jsonl");
    await booted.daemon.scan();
    await booted.daemon.settled();
    await tickOnce(booted);
    expect(booted.recallCalls).toHaveLength(1);

    const put = await fetch(`${booted.daemon.baseUrl}/api/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${booted.daemon.token}`, "content-type": "application/json" },
      body: JSON.stringify({ reminders: { notifications: false } }),
    });
    expect(put.ok).toBe(true);
    await writeClaudeSession(booted.dirs.sourceDir, [
      claudeLine("recall-off", "user", "发布流程还要补一条灰度说明", NOW_ISO),
    ], "off.jsonl");
    await booted.daemon.scan();
    await booted.daemon.settled();
    await tickOnce(booted);
    expect(booted.recallCalls).toHaveLength(1);
  });

  it("模型一直失败时上传照常完成，也不发提醒", async () => {
    const booted = await boot({
      recallReply: () => {
        throw new Error("模型不可用");
      },
      before: async (dirs) => {
        await writeClaudeSession(dirs.sourceDir, [
          claudeLine("recall-fail", "user", "发布流程这次要改成每周发布", NOW_ISO),
        ]);
      },
    });
    await booted.clock.advance(5 * 60_000);
    await booted.daemon.settled();
    expect(booted.recallCalls.length).toBeGreaterThan(0);
    expect((await booted.drive.list({ prefix: "inbox/" })).some((file) => file.path.endsWith(".md"))).toBe(true);
    expect((await reminders(booted.daemon)).filter((item) => item.kind.startsWith("recall"))).toHaveLength(0);
  });

  it("网页会话处理设备上，网页会话聊到旧话题时同样提醒", async () => {
    const booted = await boot();
    await receiveWebSession(booted, "web-1", {});
    const items = (await reminders(booted.daemon)).filter((item) => item.kind.startsWith("recall"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "recall", topicId: TOPIC });
  });

  it("非网页会话处理设备不考虑网页会话", async () => {
    const booted = await boot();
    await receiveWebSession(booted, "web-2", { webProcessor: "00000000-0000-4000-8000-000000000001" });
    expect(booted.recallCalls).toHaveLength(0);
    expect((await reminders(booted.daemon)).filter((item) => item.kind.startsWith("recall"))).toHaveLength(0);
  });
});
