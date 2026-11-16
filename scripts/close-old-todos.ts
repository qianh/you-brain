/**
 * Closes open todos older than N days as dropped, so what stays open is what was said
 * recently. Todos accumulate: a library built by backfilling history held hundreds of
 * open ones, most of them long done or never going to happen, and nothing closed them.
 *
 * They are closed as `dropped`, not `done`: nobody checked whether the work happened.
 * The change is an event (`todo.status_changed`, `by: "auto"`), which does not make the
 * topic look recently active and does not override a todo the user changed by hand.
 *
 * Stop the daemon first. Run with `--apply`; without it the script only reports.
 * Usage: bun scripts/close-old-todos.ts <state.sqlite> [--days 7] [--apply]
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { EventLog } from "../packages/core/src/sync/event-log.js";
import { SqliteStore } from "../packages/core/src/store/sqlite-store.js";
import { foldEvents } from "../packages/core/src/topics/fold.js";
import { persistTopicBook } from "../packages/core/src/topics/persist.js";
import { selectStaleOpenTodos } from "../packages/core/src/topics/stale-todos.js";

const dbPath = process.argv.find((arg) => arg.endsWith(".sqlite"));
const apply = process.argv.includes("--apply");
const daysIndex = process.argv.indexOf("--days");
const days = daysIndex >= 0 ? Number(process.argv[daysIndex + 1]) : 7;
if (!dbPath) {
  console.error(
    "usage: bun scripts/close-old-todos.ts <state.sqlite> [--days 7] [--apply]",
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

const nowMs = Date.now();
const stale = selectStaleOpenTodos(book.todos, nowMs, days);
const openTotal = book.todos.filter((todo) => todo.status === "open").length;
const kept = book.todos.filter(
  (todo) => todo.status === "open" && !stale.some((item) => item.todoId === todo.todoId),
);

const topicName = new Map(book.topics.map((topic) => [topic.topicId, topic.name]));
const perTopic = new Map<string, number>();
for (const todo of stale) perTopic.set(todo.topicId, (perTopic.get(todo.topicId) ?? 0) + 1);
const keptTopics = new Set(kept.map((todo) => todo.topicId));

console.log(`开放待办共 ${openTotal} 条`);
console.log(`条件：状态开放、本人没改过、创建早于 ${days} 天前`);
console.log(`将作废：${stale.length} 条`);
console.log(`保留：${kept.length} 条，分布在 ${keptTopics.size} 个话题`);
const largest = [...perTopic.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5);
for (const [topicId, count] of largest) {
  console.log(`  · ${topicName.get(topicId) ?? topicId}：${count} 条`);
}
if (perTopic.size > largest.length) console.log(`  … 其余 ${perTopic.size - largest.length} 个话题`);

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
const added = stale.map((todo) =>
  log.allocate("todo.status_changed", {
    todoId: todo.todoId,
    status: "dropped",
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
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM todos WHERE status = 'open'")
    .get();
  console.log(`\n完成。事件 +${added.length}，开放待办现在 ${remaining?.n ?? 0} 条。`);
} finally {
  check.close();
}
