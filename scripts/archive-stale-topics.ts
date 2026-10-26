/**
 * Marks single-session topics as done, so the topic shelf stops carrying hundreds of
 * conversations that were never going to be followed up.
 *
 * A library built by backfilling history ends up with one topic per short conversation:
 * most of them hold a single session, add an open todo, and never come back. They stay
 * out of the active zone but fill the history list, and each one was also a weekly
 * reminder before that was removed.
 *
 * The change is an event (`topic.status_changed`, `by: "auto"`), not a row edit: the
 * topic book is folded from the event log on every read. Open todos are left alone —
 * the topic just stops counting as something in progress.
 *
 * Stop the daemon first. Run with `--apply`; without it the script only reports.
 * Usage: bun scripts/archive-stale-topics.ts <state.sqlite> [--days 7] [--apply]
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { EventLog } from "../packages/core/src/sync/event-log.js";
import { SqliteStore } from "../packages/core/src/store/sqlite-store.js";
import { foldEvents } from "../packages/core/src/topics/fold.js";
import { persistTopicBook } from "../packages/core/src/topics/persist.js";

const dbPath = process.argv.find((arg) => arg.endsWith(".sqlite"));
const apply = process.argv.includes("--apply");
const daysIndex = process.argv.indexOf("--days");
const days = daysIndex >= 0 ? Number(process.argv[daysIndex + 1]) : 7;
if (!dbPath) {
  console.error(
    "usage: bun scripts/archive-stale-topics.ts <state.sqlite> [--days 7] [--apply]",
  );
  process.exit(2);
}
if (!Number.isFinite(days) || days <= 0) {
  console.error("--days must be a positive number");
  process.exit(2);
}

/** The daemon holds the database; rewriting the derived tables under it would race. */
function daemonPid(dataDir: string): number | null {
  try {
    const state = JSON.parse(readFileSync(join(dataDir, "daemon.json"), "utf8")) as {
      pid?: number;
    };
    const pid = state.pid;
    if (typeof pid !== "number") return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

const running = daemonPid(dirname(dbPath));
if (running !== null) {
  console.error(`daemon 正在运行（pid ${running}），先退出应用再执行`);
  process.exit(2);
}

const store = new SqliteStore(dbPath);
const book = foldEvents(store.listEvents());

const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
const sessionCount = new Map<string, number>();
const lastSession = new Map<string, string>();
for (const session of store.listSessions()) {
  if (session.topicId === null) continue;
  sessionCount.set(session.topicId, (sessionCount.get(session.topicId) ?? 0) + 1);
  if (session.updatedAt !== null) lastSession.set(session.topicId, session.updatedAt);
}

const candidates = book.topics.filter((topic) => {
  if (topic.mergedInto !== null || topic.status !== "active") return false;
  if ((sessionCount.get(topic.topicId) ?? 0) > 1) return false;
  const last = lastSession.get(topic.topicId);
  // A topic with no session at all has nothing to judge by; leave it alone.
  if (last === undefined) return false;
  const ms = Date.parse(last);
  return !Number.isNaN(ms) && ms < cutoffMs;
});

const openTodos = new Map<string, number>();
for (const todo of book.todos.values()) {
  if (todo.status !== "open" || todo.topicId === "") continue;
  openTodos.set(todo.topicId, (openTodos.get(todo.topicId) ?? 0) + 1);
}

const activeBefore = book.topics.filter(
  (topic) => topic.mergedInto === null && topic.status === "active",
).length;
const todosTouched = candidates.reduce(
  (sum, topic) => sum + (openTodos.get(topic.topicId) ?? 0),
  0,
);

console.log(`话题总数 ${book.topics.length}，其中进行中 ${activeBefore}`);
console.log(`条件：只有 1 个会话，且最后一次活跃早于 ${days} 天前`);
console.log(`将标记为已完成：${candidates.length} 个`);
console.log(`这些话题名下的未完成待办：${todosTouched} 项（待办本身不动，话题不再算进行中）`);
console.log(`结果：进行中 ${activeBefore} → ${activeBefore - candidates.length}`);
for (const topic of candidates.slice(0, 5)) {
  console.log(`  · ${topic.name}`);
}
if (candidates.length > 5) console.log(`  … 其余 ${candidates.length - 5} 个`);

if (!apply) {
  console.log("\n只报告，未修改。加 --apply 执行。");
  process.exit(0);
}

// Allocate through EventLog so sequence numbers stay monotonic per device, then insert
// the events and rebuild the derived tables from the whole log.
const raw = new Database(dbPath);
raw.exec("PRAGMA busy_timeout = 10000");
let deviceId = "";
try {
  const row = raw
    .query<{ device_id: string }, []>("SELECT device_id FROM devices ORDER BY last_seen_at DESC LIMIT 1")
    .get();
  deviceId = row?.device_id ?? "";
} finally {
  raw.close();
}
if (deviceId === "") {
  console.error("找不到本机 device_id，中止");
  process.exit(2);
}

const log = new EventLog(store, deviceId, { now: () => new Date() });
const added = candidates.map((topic) =>
  log.allocate("topic.status_changed", {
    topicId: topic.topicId,
    status: "done",
    by: "auto",
  }),
);

const write = new Database(dbPath);
write.exec("PRAGMA busy_timeout = 10000");
try {
  const insert = write.prepare(
    `INSERT OR IGNORE INTO events (id, ts, ts_ms, device, seq, type, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = write.transaction(() => {
    for (const event of added) {
      insert.run(
        event.id,
        event.ts,
        Date.parse(event.ts),
        event.device,
        event.seq,
        event.type,
        JSON.stringify(event),
      );
    }
  });
  tx();
} finally {
  write.close();
}

persistTopicBook(store, foldEvents(store.listEvents()));
store.close();

const check = new Database(dbPath, { readonly: true });
try {
  const remaining = check
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM topics WHERE merged_into IS NULL AND status = 'active'")
    .get();
  console.log(`\n完成。事件 +${added.length}，进行中话题现在 ${remaining?.n ?? 0} 个。`);
  if (!existsSync(dbPath)) console.error("数据库不见了？");
} finally {
  check.close();
}
