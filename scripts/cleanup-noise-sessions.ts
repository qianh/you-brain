/**
 * One-off cleanup: drop CLI startup noise from an existing state database.
 *
 * A Codex session file is written even when nothing is asked, so a library can hold
 * thousands of "sessions" whose only content is injected `AGENTS.md` or
 * `<environment_context>` text. Those sessions were refined into topics named
 * "会话环境初始化" and similar, which is why the topic list filled up with topics
 * that hold a single empty session.
 *
 * The topic book is folded from the event log on every read, so deleting rows from
 * `sessions` alone is not enough: the noise events have to go too.
 *
 * The stored row cannot decide on its own (`msg_count` cannot tell a real
 * one-question-one-answer exchange from an injected prompt plus "Understood"), and the
 * database does not keep source paths. So this walks the configured source roots with
 * the adapters, collects the conversation keys that pass `isConversation`, and removes
 * the sessions whose key is not among them.
 *
 * Run with `--apply`; without it the script only reports.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { discoverSessions } from "../packages/core/src/adapters/index.js";
import { conversationKey, type SessionSource } from "../packages/core/src/domain/session.js";

const dbPath = process.argv.find((arg) => arg.endsWith(".sqlite"));
const apply = process.argv.includes("--apply");
if (!dbPath) {
  console.error("usage: bun scripts/cleanup-noise-sessions.ts <state.sqlite> [--apply]");
  process.exit(2);
}

const home = homedir();
const sources: SessionSource[] = [
  "claude-code",
  "codex",
  "grok-build",
  "cursor",
  "gemini-cli",
  "pi",
  "t3-code",
];
const paths = {
  claude: [join(home, ".claude", "projects")],
  codex: [join(home, ".codex", "sessions")],
  grok: [join(home, ".grok", "sessions")],
  cursor: [join(home, ".cursor", "projects")],
  gemini: [join(home, ".gemini", "tmp")],
  pi: [join(home, ".pi", "agent", "sessions")],
  t3: [join(home, ".t3", "userdata")],
};

console.log("扫描本机源目录…");
const discovered = await discoverSessions({
  device: "cleanup",
  includeSubagents: true,
  sources,
  paths,
  retainSessions: true,
});
const liveKeys = new Set(
  discovered.sessions.map((session) => conversationKey(session.source, session.conversationId)),
);
console.log("本机真实会话:", liveKeys.size);
for (const [name, status] of Object.entries(discovered.status)) {
  console.log(
    `  ${name.padEnd(7)} 发现 ${String(status.discovered).padStart(5)}  真实 ${String(status.captured).padStart(5)}  噪音 ${String(status.skippedNoise).padStart(5)}`,
  );
}

const db = new Database(dbPath);
db.exec("PRAGMA busy_timeout = 10000");

interface SessionRow {
  session_key: string;
  source: string;
  device: string;
  title: string;
  msg_count: number;
  topic_id: string | null;
}

const sessions = db
  .query<SessionRow, []>(
    `SELECT session_key, source, device, title, msg_count, topic_id FROM sessions`,
  )
  .all();

/** Titles a refine step produced for a session that held only injected context. */
const NOISE_TITLES = new Set([
  "会话环境初始化",
  "会话初始化",
  "会话启动",
  "会话环境与技能规则初始化",
  "根目录只读沙箱会话初始化",
  "只读沙箱会话环境初始化",
  "会话启动环境与技能说明",
  "助手身份询问",
]);

/**
 * Only this device's sessions can be checked against the local files. Another device's
 * sessions are left alone: their files are not here, so there is nothing to re-read.
 * The name comes from `config.toml` next to the database, never from a row: the largest
 * device in a synced library is usually a different machine.
 */
function localDeviceName(statePath: string): string | null {
  try {
    const text = readFileSync(join(dirname(statePath), "config.toml"), "utf8");
    return /^display_name\s*=\s*"([^"]+)"/mu.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

const localDevice = localDeviceName(dbPath);
if (localDevice === null) {
  console.error("找不到本机设备名（config.toml 的 display_name），中止以免删错设备");
  process.exit(2);
}
console.log("\n本机设备:", localDevice);

const noiseKeys = new Set<string>();
let checked = 0;
let unknown = 0;
for (const row of sessions) {
  if (row.device !== localDevice) continue; // another device's files are not here
  if (liveKeys.has(row.session_key)) continue; // a real conversation
  if (row.source === "chatgpt-web" || row.source === "grok-web" || row.source === "claude-web") {
    // Browser-plugin sessions have no local file. Fall back to the stored row.
    if (row.msg_count < 2 || NOISE_TITLES.has(row.title)) {
      noiseKeys.add(row.session_key);
      unknown += 1;
    }
    continue;
  }
  // A local file-backed source with no real conversation on disk: startup noise.
  noiseKeys.add(row.session_key);
  checked += 1;
}
console.log(`本机会话: ${sessions.filter((row) => row.device === localDevice).length}`);
console.log(`按源文件判定为噪音: ${checked}`);
console.log(`按库内行判定为噪音: ${unknown}`);

const events = db
  .query<{ id: string; ts: string; payload: string }, []>(
    "SELECT id, ts, payload FROM events",
  )
  .all();
const noiseEventIds = new Set<string>();
for (const event of events) {
  const data = (JSON.parse(event.payload) as { data?: Record<string, unknown> }).data ?? {};
  const sessionKey = typeof data.sessionKey === "string" ? data.sessionKey : null;
  if (sessionKey !== null && noiseKeys.has(sessionKey)) noiseEventIds.add(event.id);
}

const realTopicIds = new Set(
  sessions
    .filter((row) => !noiseKeys.has(row.session_key) && row.topic_id !== null)
    .map((row) => row.topic_id as string),
);
const topics = db.query<{ topic_id: string }, []>("SELECT topic_id FROM topics").all();
const deadTopicIds = new Set(
  topics.map((topic) => topic.topic_id).filter((id) => !realTopicIds.has(id)),
);
for (const event of events) {
  const data = (JSON.parse(event.payload) as { data?: Record<string, unknown> }).data ?? {};
  if (typeof data.topicId === "string" && deadTopicIds.has(data.topicId)) {
    noiseEventIds.add(event.id);
  }
}

const ids = [...deadTopicIds];
const placeholders = ids.map(() => "?").join(",") || "''";
const countIn = (table: string): number =>
  (
    db
      .query<{ count: number }, string[]>(
        `SELECT COUNT(*) AS count FROM ${table} WHERE topic_id IN (${placeholders})`,
      )
      .get(...ids) as { count: number }
  ).count;

const days = new Map<string, number>();
for (const event of events) {
  if (!noiseEventIds.has(event.id)) continue;
  const day = event.ts.slice(0, 10);
  days.set(day, (days.get(day) ?? 0) + 1);
}

console.log(`\n要删的会话：${noiseKeys.size} / ${sessions.length}`);
console.log(`要删的事件：${noiseEventIds.size}`);
for (const [day, count] of [...days].sort()) console.log(`  ${day}: ${count}`);
console.log(`要删的话题：${deadTopicIds.size} / ${topics.length}`);
console.log(`要删的结论：${countIn("conclusions")}`);
console.log(`要删的待办：${countIn("todos")}`);

if (!apply) {
  console.log("\n只报告，未修改。加 --apply 执行。");
  process.exit(0);
}

db.transaction(() => {
  const deleteEvent = db.prepare("DELETE FROM events WHERE id = ?");
  for (const id of noiseEventIds) deleteEvent.run(id);
  const deleteSession = db.prepare("DELETE FROM sessions WHERE session_key = ?");
  for (const key of noiseKeys) deleteSession.run(key);
  if (ids.length > 0) {
    db.prepare(`DELETE FROM conclusions WHERE topic_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM todos WHERE topic_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM reminders WHERE topic_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM topics WHERE topic_id IN (${placeholders})`).run(...ids);
  }
})();

// Derived tables are rebuilt from the event log on the next fold; clear them so the
// first read after cleanup does not show topics whose events are gone.
db.exec("DELETE FROM conclusions");
db.exec("DELETE FROM todos");
db.exec("DELETE FROM topics");
db.exec("DELETE FROM reminders");
db.exec("UPDATE sessions SET topic_id = NULL");

console.log(
  "\n清理后:",
  db
    .query<Record<string, number>, []>(
      `SELECT (SELECT COUNT(*) FROM sessions) AS sessions,
              (SELECT COUNT(*) FROM events) AS events,
              (SELECT COUNT(*) FROM topics) AS topics`,
    )
    .get(),
);
db.close();
