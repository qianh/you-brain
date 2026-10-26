export interface SchemaMigration {
  version: number;
  sql: string;
}

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  session_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  device TEXT NOT NULL,
  file_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  updated_at TEXT,
  started_at_ms INTEGER,
  updated_at_ms INTEGER,
  msg_count INTEGER NOT NULL DEFAULT 0,
  refined_up_to INTEGER NOT NULL DEFAULT 0,
  topic_id TEXT
);
CREATE INDEX IF NOT EXISTS sessions_updated_at_ms ON sessions(updated_at_ms);
CREATE INDEX IF NOT EXISTS sessions_topic_id ON sessions(topic_id);
CREATE TABLE IF NOT EXISTS topics (
  topic_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'follow_up', 'done', 'parked')),
  status_by TEXT NOT NULL CHECK (status_by IN ('auto', 'user')),
  summary TEXT NOT NULL DEFAULT '',
  next_step TEXT NOT NULL DEFAULT '',
  last_active TEXT,
  merged_into TEXT,
  created_ts TEXT,
  last_user_op_at TEXT,
  user_locked INTEGER NOT NULL DEFAULT 0 CHECK (user_locked IN (0, 1))
);
CREATE TABLE IF NOT EXISTS conclusions (
  conclusion_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  text TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conclusions_topic_id ON conclusions(topic_id);
CREATE TABLE IF NOT EXISTS todos (
  todo_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'done', 'dropped')),
  status_by TEXT NOT NULL CHECK (status_by IN ('auto', 'user')),
  confidence REAL NOT NULL,
  ts TEXT NOT NULL,
  user_locked INTEGER NOT NULL DEFAULT 0 CHECK (user_locked IN (0, 1))
);
CREATE INDEX IF NOT EXISTS todos_topic_id ON todos(topic_id);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  device TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_order ON events(ts_ms, device, seq, id);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'upload')),
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'inflight', 'acked')) DEFAULT 'pending',
  acked_at TEXT
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status, created_at, id);
CREATE TABLE IF NOT EXISTS cursors (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  capabilities TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS portrait (
  variant TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders (
  reminder_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  topic_id TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  until_at TEXT,
  issued_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reminders_topic_id ON reminders(topic_id);
`;

const MIGRATION_2 = `
CREATE INDEX IF NOT EXISTS events_type ON events(type);
`;

/**
 * `last_user_op_at` also moves when the user dismisses a reminder, which is what the
 * reminder streak needs. The topic list needs the moment the topic itself was worked
 * on, so it gets its own column. Existing rows start empty and fill on the next fold.
 */
const MIGRATION_3 = `
ALTER TABLE topics ADD COLUMN last_content_at TEXT;
`;

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  { version: 1, sql: MIGRATION_1 },
  { version: 2, sql: MIGRATION_2 },
  { version: 3, sql: MIGRATION_3 },
];

const latest = SCHEMA_MIGRATIONS[SCHEMA_MIGRATIONS.length - 1];
export const SCHEMA_VERSION = latest ? latest.version : 0;

export const TOPIC_TABLES = [
  "sessions",
  "topics",
  "conclusions",
  "todos",
  "events",
  "outbox",
  "cursors",
  "devices",
  "portrait",
  "reminders",
] as const;
