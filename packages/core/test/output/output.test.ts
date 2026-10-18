import { lstat, mkdtemp, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeviceRecord, Event } from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import { platformPaths, type YouBrainPaths } from "../../src/domain/paths.js";
import { ManualClock } from "../../src/output/clock.js";
import { OutputService } from "../../src/output/service.js";
import { renderLocalMarkdown } from "../../src/output/render.js";
import { SqliteStore } from "../../src/store/index.js";
import type { SessionRecord, TopicRecord } from "../../src/store/types.js";
import { persistTopicBook } from "../../src/topics/persist.js";
import { foldEvents } from "../../src/topics/fold.js";
import { buildEvent, sessionKey } from "../topics/helpers.js";

const NOW = "2026-10-18T02:00:00.000Z";
const TODAY_SESSION = "2026-10-17T16:30:00.000Z";
const LOOSE_SESSION = "2026-10-18T01:00:00.000Z";
const OLD_SESSION = "2026-09-01T02:00:00.000Z";
const YESTERDAY = "2026-10-17T15:59:00.000Z";
const DEVICE = "11111111-1111-4111-8111-111111111111";

const TODAY_ZH = `# 今日

## 你脑设计

### 同步方案
- 来源：Claude Code
- 设备：MacBook
- 时间：2026-10-18 00:30
- 标题：同步方案
- 概要：讨论了事件日志。
- 话题：你脑设计
- Drive：https://drive.google.com/file/d/file-today/view

## 未归入话题

### 零碎问题
- 来源：Codex
- 设备：MacBook
- 时间：2026-10-18 09:00
- 标题：零碎问题
- 概要：没有归入话题。
- 话题：未归入话题
- Drive：https://drive.google.com/file/d/file-loose/view
`;

const TOPICS_ZH = `# 话题

## 活跃

### 你脑设计
- 状态：进行中
- 概要：本地优先的会话册。
- 下一步：补齐输出。
- 未完成待办：
  - 先写输出
  - 再补测试
- 最近结论：
  - 新结论（2026-10-18 00:40）
  - 旧结论（2026-10-17 12:00）
- 相关会话：
  - [同步方案](https://drive.google.com/file/d/file-today/view)

## 历史

- 旧项目
- 已完成事项
`;

const REMINDERS_ZH = `# 提醒

暂无提醒
`;

const TODAY_EN = `# Today

## 你脑设计

### 同步方案
- Source: Claude Code
- Device: MacBook
- Time: 2026-10-18 00:30
- Title: 同步方案
- Summary: 讨论了事件日志。
- Topic: 你脑设计
- Drive: https://drive.google.com/file/d/file-today/view

## Unassigned

### 零碎问题
- Source: Codex
- Device: MacBook
- Time: 2026-10-18 09:00
- Title: 零碎问题
- Summary: 没有归入话题。
- Topic: Unassigned
- Drive: https://drive.google.com/file/d/file-loose/view
`;

const TOPICS_EN = `# Topics

## Active

### 你脑设计
- Status: Active
- Summary: 本地优先的会话册。
- Next step: 补齐输出。
- Open todos:
  - 先写输出
  - 再补测试
- Recent conclusions:
  - 新结论 (2026-10-18 00:40)
  - 旧结论 (2026-10-17 12:00)
- Sessions:
  - [同步方案](https://drive.google.com/file/d/file-today/view)

## History

- 旧项目
- 已完成事项
`;

const REMINDERS_EN = `# Reminders

No reminders yet
`;

function pathsFor(home: string): YouBrainPaths {
  return platformPaths({ platform: "darwin", homeDir: home, env: {} });
}

function device(): DeviceRecord {
  return {
    deviceId: DEVICE,
    displayName: "MacBook",
    kind: "desktop",
    platform: "darwin",
    appVersion: "0.1.0",
    protocolVersion: 1,
    capabilities: ["capture"],
    lastSeenAt: NOW,
    lastActiveAt: NOW,
  };
}

function events(): Event[] {
  const keyToday = sessionKey(1);
  const keyOld = sessionKey(3);
  return [
    buildEvent({
      type: "topic.created",
      data: { topicId: "topic-you", name: "你脑设计", aliases: [] },
      device: DEVICE,
      ts: "2026-10-01T00:00:01.000Z",
      seq: 1,
    }),
    buildEvent({
      type: "topic.created",
      data: { topicId: "topic-old", name: "旧项目", aliases: [] },
      device: DEVICE,
      ts: "2026-10-01T00:00:02.000Z",
      seq: 2,
    }),
    buildEvent({
      type: "topic.created",
      data: { topicId: "topic-done", name: "已完成事项", aliases: [] },
      device: DEVICE,
      ts: "2026-10-01T00:00:03.000Z",
      seq: 3,
    }),
    buildEvent({
      type: "topic.created",
      data: { topicId: "topic-merged", name: "被合并的话题", aliases: [] },
      device: DEVICE,
      ts: "2026-10-01T00:00:04.000Z",
      seq: 4,
    }),
    buildEvent({
      type: "topic.status_changed",
      data: { topicId: "topic-done", status: "done", by: "auto" },
      device: DEVICE,
      ts: "2026-10-01T00:00:05.000Z",
      seq: 5,
    }),
    buildEvent({
      type: "topic.merged",
      data: { fromTopicId: "topic-merged", intoTopicId: "topic-you" },
      device: DEVICE,
      ts: "2026-10-01T00:00:06.000Z",
      seq: 6,
    }),
    buildEvent({
      type: "topic.summary_rewritten",
      data: { topicId: "topic-you", summary: "本地优先的会话册。", nextStep: "补齐输出。" },
      device: DEVICE,
      ts: "2026-10-01T00:00:07.000Z",
      seq: 7,
    }),
    buildEvent({
      type: "topic.summary_rewritten",
      data: { topicId: "topic-old", summary: "已经沉下去了。", nextStep: "没了。" },
      device: DEVICE,
      ts: "2026-10-01T00:00:08.000Z",
      seq: 8,
    }),
    buildEvent({
      type: "session.refined",
      data: {
        sessionKey: keyToday,
        fileId: "file-today",
        source: "claude-code",
        title: "同步方案",
        summary: "讨论了事件日志。",
        refinedUpTo: 1,
      },
      device: DEVICE,
      ts: "2026-10-01T00:00:09.000Z",
      seq: 9,
    }),
    buildEvent({
      type: "session.refined",
      data: {
        sessionKey: keyOld,
        fileId: "file-old",
        source: "cursor",
        title: "旧会话",
        summary: "很久以前。",
        refinedUpTo: 1,
      },
      device: DEVICE,
      ts: "2026-10-01T00:00:10.000Z",
      seq: 10,
    }),
    buildEvent({
      type: "topic.assigned",
      data: { topicId: "topic-you", sessionKey: keyToday },
      device: DEVICE,
      ts: "2026-10-01T00:00:11.000Z",
      seq: 11,
    }),
    buildEvent({
      type: "topic.assigned",
      data: { topicId: "topic-old", sessionKey: keyOld },
      device: DEVICE,
      ts: "2026-10-01T00:00:12.000Z",
      seq: 12,
    }),
    buildEvent({
      type: "conclusion.added",
      data: {
        conclusionId: "c-old",
        topicId: "topic-you",
        text: "旧结论",
        sessionKey: keyToday,
      },
      device: DEVICE,
      ts: "2026-10-17T04:00:00.000Z",
      seq: 13,
    }),
    buildEvent({
      type: "conclusion.added",
      data: {
        conclusionId: "c-new",
        topicId: "topic-you",
        text: "新结论",
        sessionKey: keyToday,
      },
      device: DEVICE,
      ts: "2026-10-17T16:40:00.000Z",
      seq: 14,
    }),
    buildEvent({
      type: "todo.added",
      data: {
        todoId: "todo-1",
        topicId: "topic-you",
        text: "先写输出",
        sessionKey: keyToday,
        confidence: 0.9,
      },
      device: DEVICE,
      ts: "2026-10-17T16:45:00.000Z",
      seq: 15,
    }),
    buildEvent({
      type: "todo.added",
      data: {
        todoId: "todo-2",
        topicId: "topic-you",
        text: "再补测试",
        sessionKey: keyToday,
        confidence: 0.9,
      },
      device: DEVICE,
      ts: "2026-10-17T16:50:00.000Z",
      seq: 16,
    }),
    buildEvent({
      type: "todo.added",
      data: {
        todoId: "todo-done",
        topicId: "topic-you",
        text: "不该出现",
        sessionKey: keyToday,
        confidence: 0.9,
      },
      device: DEVICE,
      ts: "2026-10-17T16:55:00.000Z",
      seq: 17,
    }),
    buildEvent({
      type: "todo.status_changed",
      data: { todoId: "todo-done", status: "done", by: "auto" },
      device: DEVICE,
      ts: "2026-10-17T16:56:00.000Z",
      seq: 18,
    }),
  ];
}

function seed(store: SqliteStore): void {
  store.upsertDevice(device());
  store.upsertSession({
    sessionKey: sessionKey(1),
    source: "claude-code",
    device: DEVICE,
    fileId: "file-today",
    title: "同步方案",
    summary: "讨论了事件日志。",
    startedAt: TODAY_SESSION,
    updatedAt: TODAY_SESSION,
    topicId: "topic-you",
  });
  store.upsertSession({
    sessionKey: sessionKey(2),
    source: "codex",
    device: DEVICE,
    fileId: "file-loose",
    title: "零碎问题",
    summary: "没有归入话题。",
    startedAt: LOOSE_SESSION,
    updatedAt: LOOSE_SESSION,
  });
  store.upsertSession({
    sessionKey: sessionKey(3),
    source: "cursor",
    device: DEVICE,
    fileId: "file-old",
    title: "旧会话",
    summary: "很久以前。",
    startedAt: OLD_SESSION,
    updatedAt: OLD_SESSION,
    topicId: "topic-old",
  });
  store.upsertSession({
    sessionKey: sessionKey(4),
    source: "gemini-cli",
    device: DEVICE,
    fileId: "file-yest",
    title: "昨天的尾巴",
    summary: "不算今天。",
    startedAt: YESTERDAY,
    updatedAt: YESTERDAY,
  });
  persistTopicBook(store, foldEvents(events()));
  store.upsertReminder({
    reminderId: "r1",
    kind: "stalled",
    topicId: "topic-you",
    text: "这条不该出现",
    status: "open",
    until: null,
    issuedAt: NOW,
    updatedAt: NOW,
  });
}

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), "you-brain-output-"));
}

describe("local markdown output", () => {
  it("writes Chinese snapshots and an English copy from the store", async () => {
    const root = await home();
    const paths = pathsFor(root);
    const store = new SqliteStore(join(paths.dataDir, "state.sqlite"));
    const clock = new ManualClock(new Date(NOW));
    try {
      seed(store);
      const writer = new OutputService({
        source: store,
        paths,
        language: "zh",
        timeZone: "Asia/Shanghai",
        activeLimit: 10,
        historyDays: 30,
        clock,
      });
      const written = await writer.flush();
      expect(written).toEqual({ today: true, topics: true, reminders: true });
      expect(await readFile(paths.todayFile, "utf8")).toBe(TODAY_ZH);
      expect(await readFile(paths.topicsFile, "utf8")).toBe(TOPICS_ZH);
      expect(await readFile(paths.remindersFile, "utf8")).toBe(REMINDERS_ZH);
      expect(await readFile(paths.todayFile, "utf8")).not.toContain("昨天的尾巴");
      expect(await readFile(paths.todayFile, "utf8")).not.toContain("旧会话");
      expect(await readFile(paths.topicsFile, "utf8")).not.toContain("被合并的话题");
      expect(await readFile(paths.topicsFile, "utf8")).not.toContain("不该出现");
      expect(await readFile(paths.remindersFile, "utf8")).not.toContain("这条不该出现");
      for (const file of [paths.todayFile, paths.topicsFile, paths.remindersFile]) {
        expect((await lstat(file)).mode & 0o777).toBe(0o600);
      }
      const names = await readdir(paths.outputDir);
      expect(names.filter((name) => name.includes(".tmp"))).toEqual([]);

      const englishHome = join(root, "en-home");
      const englishPaths = pathsFor(englishHome);
      const english = new OutputService({
        source: store,
        paths: englishPaths,
        language: "en",
        timeZone: "Asia/Shanghai",
        activeLimit: 10,
        historyDays: 30,
        clock,
      });
      await english.flush();
      expect(await readFile(englishPaths.todayFile, "utf8")).toBe(TODAY_EN);
      expect(await readFile(englishPaths.topicsFile, "utf8")).toBe(TOPICS_EN);
      expect(await readFile(englishPaths.remindersFile, "utf8")).toBe(REMINDERS_EN);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives the active list with the zones limit and drops done topics", () => {
    const now = new Date(NOW);
    const recent = "2026-10-18T01:00:00.000Z";
    const older = "2026-10-17T01:00:00.000Z";
    const topic = (
      topicId: string,
      name: string,
      status: TopicRecord["status"],
      lastActive: string,
    ): TopicRecord => ({
      topicId,
      name,
      aliases: [],
      status,
      statusBy: "auto",
      summary: "",
      nextStep: "",
      lastActive,
      mergedInto: null,
      createdTs: recent,
      lastUserOpAt: null,
      userLocked: false,
    });
    const session = (n: number, topicId: string, updatedAt: string): SessionRecord => ({
      sessionKey: sessionKey(n),
      source: "codex",
      device: DEVICE,
      fileId: null,
      title: nameOf(n),
      summary: "",
      startedAt: updatedAt,
      updatedAt,
      msgCount: 1,
      refinedUpTo: 1,
      topicId,
    });
    const rendered = renderLocalMarkdown({
      now,
      timeZone: "Asia/Shanghai",
      language: "zh",
      activeLimit: 1,
      historyDays: 30,
      topics: [
        topic("new", "新的", "active", recent),
        topic("mid", "较早", "active", older),
        topic("done", "做完了", "done", recent),
      ],
      sessions: [session(11, "new", recent), session(12, "mid", older), session(13, "done", recent)],
      todaySessions: [],
      conclusions: [],
      todos: [],
      devices: [],
    });
    expect(rendered.topics).toContain("### 新的");
    expect(rendered.topics).not.toContain("### 较早");
    expect(rendered.topics).not.toContain("### 做完了");
    expect(rendered.topics).toContain("- 较早");
    expect(rendered.topics).toContain("- 做完了");
  });

  it("debounces for 10 seconds and skips a rewrite when the markdown is unchanged", async () => {
    const root = await home();
    const paths = pathsFor(root);
    const store = new SqliteStore(join(paths.dataDir, "state.sqlite"));
    const clock = new ManualClock(new Date(NOW));
    try {
      const writer = new OutputService({
        source: store,
        paths,
        language: "zh",
        timeZone: "Asia/Shanghai",
        clock,
      });
      writer.schedule();
      clock.advance(9_000);
      await writer.whenIdle();
      await expect(stat(paths.todayFile)).rejects.toThrow();
      writer.schedule();
      clock.advance(9_000);
      await writer.whenIdle();
      await expect(stat(paths.todayFile)).rejects.toThrow();
      clock.advance(1_000);
      await writer.whenIdle();
      expect(await readFile(paths.todayFile, "utf8")).toContain("今天还没有会话。");

      const old = new Date("2020-06-01T00:00:00.000Z");
      await utimes(paths.todayFile, old, old);
      await utimes(paths.topicsFile, old, old);
      await utimes(paths.remindersFile, old, old);
      const skipped = await writer.flush();
      expect(skipped).toEqual({ today: false, topics: false, reminders: false });
      expect((await stat(paths.todayFile)).mtimeMs).toBeLessThan(Date.parse("2021-01-01T00:00:00.000Z"));

      store.upsertSession({
        sessionKey: sessionKey(2),
        source: "codex",
        device: DEVICE,
        fileId: "file-loose",
        title: "新标题",
        summary: "更新了。",
        startedAt: LOOSE_SESSION,
        updatedAt: LOOSE_SESSION,
      });
      const changed = await writer.flush();
      expect(changed.today).toBe(true);
      expect(changed.reminders).toBe(false);
      expect(await readFile(paths.todayFile, "utf8")).toContain("新标题");
      expect((await stat(paths.todayFile)).mtimeMs).toBeGreaterThan(
        Date.parse("2024-01-01T00:00:00.000Z"),
      );
      writer.close();
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function nameOf(n: number): string {
  return `session-${n}`;
}
