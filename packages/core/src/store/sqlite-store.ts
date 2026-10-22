import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";
import {
  parseDeviceRecord,
  parseEvent,
  SessionKeySchema,
  type DeviceRecord,
  type Event,
  type EventType,
} from "@you-brain/protocol";

import { YouBrainError } from "../domain/errors.js";
import { SCHEMA_MIGRATIONS } from "./schema.js";
import { parseTimestamp, zonedDayRange } from "./time.js";
import type {
  ConclusionRecord,
  DerivedSnapshot,
  OutboxInput,
  OutboxKind,
  OutboxRecord,
  OutboxStatus,
  PortraitRecord,
  ReminderRecord,
  SessionListQuery,
  SessionRecord,
  SessionUpsert,
  TodoRecord,
  TodayQuery,
  TopicRecord,
} from "./types.js";

interface SessionRow {
  session_key: string;
  source: string;
  device: string;
  file_id: string | null;
  title: string;
  summary: string;
  started_at: string | null;
  updated_at: string | null;
  msg_count: number;
  refined_up_to: number;
  topic_id: string | null;
}

interface TopicRow {
  topic_id: string;
  name: string;
  aliases: string;
  status: TopicRecord["status"];
  status_by: TopicRecord["statusBy"];
  summary: string;
  next_step: string;
  last_active: string | null;
  merged_into: string | null;
  created_ts: string | null;
  last_user_op_at: string | null;
  user_locked: number;
}

interface ConclusionRow {
  conclusion_id: string;
  topic_id: string;
  session_key: string;
  text: string;
  ts: string;
}

interface TodoRow {
  todo_id: string;
  topic_id: string;
  session_key: string;
  text: string;
  status: TodoRecord["status"];
  status_by: TodoRecord["statusBy"];
  confidence: number;
  ts: string;
  user_locked: number;
}

interface EventRow {
  payload: string;
}

interface OutboxRow {
  id: string;
  kind: OutboxKind;
  payload: string;
  created_at: string;
  attempts: number;
  status: OutboxStatus;
  acked_at: string | null;
}

interface CursorRow {
  value: string;
}

interface DeviceRow {
  device_id: string;
  display_name: string;
  kind: string;
  platform: string;
  app_version: string;
  protocol_version: number;
  capabilities: string;
  last_seen_at: string;
  last_active_at: string;
}

interface PortraitRow {
  variant: string;
  path: string;
  version: string;
  updated_at: string;
}

interface ReminderRow {
  reminder_id: string;
  kind: string;
  topic_id: string | null;
  text: string;
  status: string;
  until_at: string | null;
  issued_at: string;
  updated_at: string;
}

function sqlBool(value: boolean): number {
  return value ? 1 : 0;
}

function parseAliases(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // Fall through to the typed error below.
  }
  throw new YouBrainError("INVALID_INPUT", "Invalid topic aliases");
}

function parsePayload(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new YouBrainError("INVALID_INPUT", "Invalid JSON payload");
  }
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    sessionKey: row.session_key,
    source: row.source,
    device: row.device,
    fileId: row.file_id,
    title: row.title,
    summary: row.summary,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    msgCount: row.msg_count,
    refinedUpTo: row.refined_up_to,
    topicId: row.topic_id,
  };
}

function mapTopic(row: TopicRow): TopicRecord {
  return {
    topicId: row.topic_id,
    name: row.name,
    aliases: parseAliases(row.aliases),
    status: row.status,
    statusBy: row.status_by,
    summary: row.summary,
    nextStep: row.next_step,
    lastActive: row.last_active,
    mergedInto: row.merged_into,
    createdTs: row.created_ts,
    lastUserOpAt: row.last_user_op_at,
    userLocked: row.user_locked === 1,
  };
}

function mapConclusion(row: ConclusionRow): ConclusionRecord {
  return {
    conclusionId: row.conclusion_id,
    topicId: row.topic_id,
    sessionKey: row.session_key,
    text: row.text,
    ts: row.ts,
  };
}

function mapTodo(row: TodoRow): TodoRecord {
  return {
    todoId: row.todo_id,
    topicId: row.topic_id,
    sessionKey: row.session_key,
    text: row.text,
    status: row.status,
    statusBy: row.status_by,
    confidence: row.confidence,
    ts: row.ts,
    userLocked: row.user_locked === 1,
  };
}

function mapOutbox(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    kind: row.kind,
    payload: parsePayload(row.payload),
    createdAt: row.created_at,
    attempts: row.attempts,
    status: row.status,
    ackedAt: row.acked_at,
  };
}

function mapPortrait(row: PortraitRow): PortraitRecord {
  return {
    variant: row.variant,
    path: row.path,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function mapReminder(row: ReminderRow): ReminderRecord {
  return {
    reminderId: row.reminder_id,
    kind: row.kind,
    topicId: row.topic_id,
    text: row.text,
    status: row.status,
    until: row.until_at,
    issuedAt: row.issued_at,
    updatedAt: row.updated_at,
  };
}

function assertNonNegativeInt(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new YouBrainError("INVALID_INPUT", `${field} must be a non-negative integer`);
  }
}

export class SqliteStore {
  readonly #db: Database;
  #closed = false;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path);
    this.#db.query("PRAGMA journal_mode = WAL").get();
    this.#db.query("PRAGMA foreign_keys = ON").get();
    this.#db.query("PRAGMA busy_timeout = 5000").get();
    this.#migrate();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  schemaVersion(): number {
    const row = this.#db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    return row?.user_version ?? 0;
  }

  migrationCount(): number {
    const row = this.#db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM schema_migrations")
      .get();
    return row?.count ?? 0;
  }

  journalMode(): string {
    const row = this.#db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
    return row?.journal_mode ?? "";
  }

  schemaObjects(): string[] {
    const rows = this.#db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    return rows.map((row) => row.name);
  }

  upsertSession(input: SessionUpsert): SessionRecord {
    const sessionKey = SessionKeySchema.parse(input.sessionKey);
    if (input.source.length === 0 || input.device.length === 0) {
      throw new YouBrainError("INVALID_INPUT", "source and device are required");
    }
    const startedMs = parseTimestamp(input.startedAt, "startedAt");
    const updatedMs = parseTimestamp(input.updatedAt, "updatedAt");
    if ("msgCount" in input) assertNonNegativeInt(input.msgCount ?? 0, "msgCount");
    if ("refinedUpTo" in input) assertNonNegativeInt(input.refinedUpTo ?? 0, "refinedUpTo");
    const existing = this.getSession(sessionKey);
    const next: SessionRecord = existing
      ? {
          ...existing,
          source: input.source,
          device: input.device,
          startedAt: input.startedAt,
          updatedAt: input.updatedAt,
        }
      : {
          sessionKey,
          source: input.source,
          device: input.device,
          fileId: null,
          title: "",
          summary: "",
          startedAt: input.startedAt,
          updatedAt: input.updatedAt,
          msgCount: 0,
          refinedUpTo: 0,
          topicId: null,
        };
    if ("fileId" in input) next.fileId = input.fileId ?? null;
    if ("title" in input) next.title = input.title ?? "";
    if ("summary" in input) next.summary = input.summary ?? "";
    if ("msgCount" in input) next.msgCount = input.msgCount ?? 0;
    if ("refinedUpTo" in input) next.refinedUpTo = input.refinedUpTo ?? 0;
    if ("topicId" in input) next.topicId = input.topicId ?? null;
    this.#db
      .query(
        `
        INSERT INTO sessions (
          session_key, source, device, file_id, title, summary,
          started_at, updated_at, started_at_ms, updated_at_ms,
          msg_count, refined_up_to, topic_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET
          source = excluded.source,
          device = excluded.device,
          file_id = excluded.file_id,
          title = excluded.title,
          summary = excluded.summary,
          started_at = excluded.started_at,
          updated_at = excluded.updated_at,
          started_at_ms = excluded.started_at_ms,
          updated_at_ms = excluded.updated_at_ms,
          msg_count = excluded.msg_count,
          refined_up_to = excluded.refined_up_to,
          topic_id = excluded.topic_id
      `,
      )
      .run(
        next.sessionKey,
        next.source,
        next.device,
        next.fileId,
        next.title,
        next.summary,
        next.startedAt,
        next.updatedAt,
        startedMs,
        updatedMs,
        next.msgCount,
        next.refinedUpTo,
        next.topicId,
      );
    return next;
  }

  getSession(sessionKey: string): SessionRecord | null {
    const row = this.#db
      .query<SessionRow, [string]>("SELECT * FROM sessions WHERE session_key = ?")
      .get(sessionKey);
    return row ? mapSession(row) : null;
  }

  listTodaySessions(query: TodayQuery): SessionRecord[] {
    const now =
      query.now === undefined
        ? new Date()
        : query.now instanceof Date
          ? query.now
          : new Date(parseTimestamp(query.now, "now"));
    const { startMs, endMs } = zonedDayRange(now, query.timeZone);
    const rows = this.#db
      .query<SessionRow, [number, number]>(
        `
        SELECT * FROM sessions
        WHERE updated_at_ms >= ? AND updated_at_ms < ?
        ORDER BY updated_at_ms DESC, session_key ASC
      `,
      )
      .all(startMs, endMs);
    return rows.map(mapSession);
  }

  /** Newest activity first. `limit` and `topicId` narrow the sessions table. */
  listSessions(query: SessionListQuery = {}): SessionRecord[] {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (query.topicId !== undefined) {
      if (query.topicId.length === 0) {
        throw new YouBrainError("INVALID_INPUT", "topicId is required");
      }
      filters.push("topic_id = ?");
      params.push(query.topicId);
    }
    let sql = "SELECT * FROM sessions";
    if (filters.length > 0) sql += ` WHERE ${filters.join(" AND ")}`;
    sql += " ORDER BY updated_at_ms DESC, session_key ASC";
    if (query.limit !== undefined) {
      assertNonNegativeInt(query.limit, "limit");
      sql += " LIMIT ?";
      params.push(query.limit);
    }
    return this.#db
      .query<SessionRow, Array<string | number>>(sql)
      .all(...params)
      .map(mapSession);
  }

  countOutbox(status?: OutboxStatus): number {
    const row =
      status === undefined
        ? this.#db
            .query<{ count: number }, []>(
              "SELECT COUNT(*) AS count FROM outbox WHERE status != 'acked'",
            )
            .get()
        : this.#db
            .query<{ count: number }, [OutboxStatus]>(
              "SELECT COUNT(*) AS count FROM outbox WHERE status = ?",
            )
            .get(status);
    return row?.count ?? 0;
  }

  getTopic(topicId: string): TopicRecord | null {
    const row = this.#db
      .query<TopicRow, [string]>("SELECT * FROM topics WHERE topic_id = ?")
      .get(topicId);
    return row ? mapTopic(row) : null;
  }

  listTopics(options?: { liveOnly?: boolean }): TopicRecord[] {
    const sql =
      options?.liveOnly === true
        ? "SELECT * FROM topics WHERE merged_into IS NULL ORDER BY topic_id"
        : "SELECT * FROM topics ORDER BY topic_id";
    return this.#db.query<TopicRow, []>(sql).all().map(mapTopic);
  }

  listConclusions(): ConclusionRecord[] {
    return this.#db
      .query<ConclusionRow, []>("SELECT * FROM conclusions ORDER BY conclusion_id")
      .all()
      .map(mapConclusion);
  }

  listTodos(): TodoRecord[] {
    return this.#db
      .query<TodoRow, []>("SELECT * FROM todos ORDER BY todo_id")
      .all()
      .map(mapTodo);
  }

  listEvents(): Event[] {
    const rows = this.#db
      .query<EventRow, []>("SELECT payload FROM events ORDER BY ts_ms, device, seq, id")
      .all();
    return rows.map((row) => parseEvent(parsePayload(row.payload)));
  }

  /** Same order as {@link listEvents}. An empty type list matches nothing. */
  listEventsByType(types: readonly EventType[]): Event[] {
    const unique = [...new Set(types)];
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => "?").join(", ");
    const rows = this.#db
      .query<EventRow, string[]>(
        `SELECT payload FROM events WHERE type IN (${placeholders}) ORDER BY ts_ms, device, seq, id`,
      )
      .all(...unique);
    return rows.map((row) => parseEvent(parsePayload(row.payload)));
  }

  replaceDerived(snapshot: DerivedSnapshot): void {
    const write = this.#db.transaction(() => {
      const insertEvent = this.#db.query(
        `
        INSERT OR IGNORE INTO events (id, ts, ts_ms, device, seq, type, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      );
      for (const event of snapshot.events) {
        const parsed = parseEvent(event);
        const tsMs = parseTimestamp(parsed.ts, "event.ts");
        insertEvent.run(
          parsed.id,
          parsed.ts,
          tsMs,
          parsed.device,
          parsed.seq,
          parsed.type,
          JSON.stringify(parsed),
        );
      }
      this.#db.exec("DELETE FROM conclusions");
      this.#db.exec("DELETE FROM todos");
      this.#db.exec("DELETE FROM topics");
      this.#db.exec("UPDATE sessions SET topic_id = NULL");
      const insertTopic = this.#db.query(
        `
        INSERT INTO topics (
          topic_id, name, aliases, status, status_by, summary, next_step,
          last_active, merged_into, created_ts, last_user_op_at, user_locked
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      );
      for (const topic of snapshot.topics) {
        insertTopic.run(
          topic.topicId,
          topic.name,
          JSON.stringify(topic.aliases),
          topic.status,
          topic.statusBy,
          topic.summary,
          topic.nextStep,
          topic.lastActive,
          topic.mergedInto,
          topic.createdTs,
          topic.lastUserOpAt,
          sqlBool(topic.userLocked),
        );
      }
      const insertConclusion = this.#db.query(
        `
        INSERT INTO conclusions (conclusion_id, topic_id, session_key, text, ts)
        VALUES (?, ?, ?, ?, ?)
      `,
      );
      for (const conclusion of snapshot.conclusions) {
        insertConclusion.run(
          conclusion.conclusionId,
          conclusion.topicId,
          conclusion.sessionKey,
          conclusion.text,
          conclusion.ts,
        );
      }
      const insertTodo = this.#db.query(
        `
        INSERT INTO todos (
          todo_id, topic_id, session_key, text, status, status_by,
          confidence, ts, user_locked
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      );
      for (const todo of snapshot.todos) {
        insertTodo.run(
          todo.todoId,
          todo.topicId,
          todo.sessionKey,
          todo.text,
          todo.status,
          todo.statusBy,
          todo.confidence,
          todo.ts,
          sqlBool(todo.userLocked),
        );
      }
      const upsertDerivedSession = this.#db.query(
        `
        INSERT INTO sessions (
          session_key, source, device, file_id, title, summary,
          started_at, updated_at, started_at_ms, updated_at_ms,
          msg_count, refined_up_to, topic_id
        ) VALUES (?, ?, '', ?, ?, ?, NULL, NULL, NULL, NULL, 0, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET
          source = CASE WHEN excluded.source = '' THEN sessions.source ELSE excluded.source END,
          file_id = CASE
            WHEN excluded.file_id IS NULL THEN sessions.file_id
            ELSE excluded.file_id
          END,
          title = excluded.title,
          summary = excluded.summary,
          refined_up_to = excluded.refined_up_to,
          topic_id = excluded.topic_id
      `,
      );
      for (const session of snapshot.sessions) {
        upsertDerivedSession.run(
          session.sessionKey,
          session.source,
          session.fileId,
          session.title,
          session.summary,
          session.refinedUpTo,
          session.topicId,
        );
      }
      if (snapshot.reminders !== undefined) {
        this.#db.exec("DELETE FROM reminders");
        for (const reminder of snapshot.reminders) this.upsertReminder(reminder);
      }
    });
    write();
  }

  enqueueOutbox(input: OutboxInput): void {
    if (input.id.length === 0) {
      throw new YouBrainError("INVALID_INPUT", "outbox id is required");
    }
    const payload = JSON.stringify(input.payload);
    if (payload === undefined) {
      throw new YouBrainError("INVALID_INPUT", "outbox payload must be JSON");
    }
    const createdAt =
      input.createdAt === undefined
        ? new Date().toISOString()
        : input.createdAt;
    if (input.createdAt !== undefined) parseTimestamp(input.createdAt, "createdAt");
    const existing = this.#db
      .query<{ id: string }, [string]>("SELECT id FROM outbox WHERE id = ?")
      .get(input.id);
    if (existing) {
      throw new YouBrainError("INVALID_INPUT", `Outbox item already exists: ${input.id}`);
    }
    this.#db
      .query(
        `
        INSERT INTO outbox (id, kind, payload, created_at, attempts, status)
        VALUES (?, ?, ?, ?, 0, 'pending')
      `,
      )
      .run(input.id, input.kind, payload, createdAt);
  }

  dequeueOutbox(limit: number): OutboxRecord[] {
    assertNonNegativeInt(limit, "limit");
    if (limit === 0) return [];
    const take = this.#db.transaction(() => {
      const ids = this.#db
        .query<{ id: string }, [number]>(
          `
          SELECT id FROM outbox
          WHERE status = 'pending'
          ORDER BY created_at, id
          LIMIT ?
        `,
        )
        .all(limit);
      if (ids.length === 0) return [];
      const mark = this.#db.query(
        "UPDATE outbox SET status = 'inflight', attempts = attempts + 1 WHERE id = ?",
      );
      for (const row of ids) mark.run(row.id);
      const load = this.#db.query<OutboxRow, [string]>("SELECT * FROM outbox WHERE id = ?");
      const records: OutboxRecord[] = [];
      for (const row of ids) {
        const loaded = load.get(row.id);
        if (loaded) records.push(mapOutbox(loaded));
      }
      return records;
    });
    return take();
  }

  ackOutbox(ids: readonly string[]): number {
    const ack = this.#db.transaction(() => {
      const now = new Date().toISOString();
      const mark = this.#db.query(
        `
        UPDATE outbox
        SET status = 'acked', acked_at = ?
        WHERE id = ? AND status != 'acked'
      `,
      );
      let changed = 0;
      for (const id of ids) changed += mark.run(now, id).changes;
      return changed;
    });
    return ack();
  }

  getOutbox(id: string): OutboxRecord | null {
    const row = this.#db
      .query<OutboxRow, [string]>("SELECT * FROM outbox WHERE id = ?")
      .get(id);
    return row ? mapOutbox(row) : null;
  }

  getCursor(key: string): string | null {
    const row = this.#db
      .query<CursorRow, [string]>("SELECT value FROM cursors WHERE key = ?")
      .get(key);
    return row ? row.value : null;
  }

  setCursor(key: string, value: string): void {
    if (key.length === 0) throw new YouBrainError("INVALID_INPUT", "cursor key is required");
    this.#db
      .query(
        `
        INSERT INTO cursors (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `,
      )
      .run(key, value, new Date().toISOString());
  }

  /** Keys that start with `prefix`, ordered by key. The match is case-sensitive. */
  listCursors(prefix: string): Array<{ key: string; value: string }> {
    const rows = this.#db
      .query<{ key: string; value: string }, [string, string]>(
        `
        SELECT key, value FROM cursors
        WHERE substr(key, 1, length(?)) = ?
        ORDER BY key
      `,
      )
      .all(prefix, prefix);
    return rows.map((row) => ({ key: row.key, value: row.value }));
  }

  upsertDevice(record: DeviceRecord): DeviceRecord {
    const parsed = parseDeviceRecord(record);
    this.#db
      .query(
        `
        INSERT INTO devices (
          device_id, display_name, kind, platform, app_version, protocol_version,
          capabilities, last_seen_at, last_active_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          display_name = excluded.display_name,
          kind = excluded.kind,
          platform = excluded.platform,
          app_version = excluded.app_version,
          protocol_version = excluded.protocol_version,
          capabilities = excluded.capabilities,
          last_seen_at = excluded.last_seen_at,
          last_active_at = excluded.last_active_at
      `,
      )
      .run(
        parsed.deviceId,
        parsed.displayName,
        parsed.kind,
        parsed.platform,
        parsed.appVersion,
        parsed.protocolVersion,
        JSON.stringify(parsed.capabilities),
        parsed.lastSeenAt,
        parsed.lastActiveAt,
      );
    return parsed;
  }

  getDevice(deviceId: string): DeviceRecord | null {
    const row = this.#db
      .query<DeviceRow, [string]>("SELECT * FROM devices WHERE device_id = ?")
      .get(deviceId);
    if (!row) return null;
    return parseDeviceRecord({
      deviceId: row.device_id,
      displayName: row.display_name,
      kind: row.kind,
      platform: row.platform,
      appVersion: row.app_version,
      protocolVersion: row.protocol_version,
      capabilities: parsePayload(row.capabilities),
      lastSeenAt: row.last_seen_at,
      lastActiveAt: row.last_active_at,
    });
  }

  deleteDevice(deviceId: string): void {
    this.#db.query("DELETE FROM devices WHERE device_id = ?").run(deviceId);
  }

  listDevices(): DeviceRecord[] {
    const rows = this.#db
      .query<DeviceRow, []>("SELECT * FROM devices ORDER BY device_id")
      .all();
    return rows.flatMap((row) => {
      const device = this.getDevice(row.device_id);
      return device ? [device] : [];
    });
  }

  upsertPortrait(record: PortraitRecord): void {
    if (record.variant.length === 0) {
      throw new YouBrainError("INVALID_INPUT", "portrait variant is required");
    }
    parseTimestamp(record.updatedAt, "updatedAt");
    this.#db
      .query(
        `
        INSERT INTO portrait (variant, path, version, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(variant) DO UPDATE SET
          path = excluded.path,
          version = excluded.version,
          updated_at = excluded.updated_at
      `,
      )
      .run(record.variant, record.path, record.version, record.updatedAt);
  }

  getPortrait(variant: string): PortraitRecord | null {
    const row = this.#db
      .query<PortraitRow, [string]>("SELECT * FROM portrait WHERE variant = ?")
      .get(variant);
    return row ? mapPortrait(row) : null;
  }

  listPortraits(): PortraitRecord[] {
    return this.#db
      .query<PortraitRow, []>("SELECT * FROM portrait ORDER BY variant")
      .all()
      .map(mapPortrait);
  }

  upsertReminder(record: ReminderRecord): void {
    if (record.reminderId.length === 0) {
      throw new YouBrainError("INVALID_INPUT", "reminder id is required");
    }
    parseTimestamp(record.issuedAt, "issuedAt");
    parseTimestamp(record.updatedAt, "updatedAt");
    if (record.until !== null) parseTimestamp(record.until, "until");
    this.#db
      .query(
        `
        INSERT INTO reminders (
          reminder_id, kind, topic_id, text, status, until_at, issued_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(reminder_id) DO UPDATE SET
          kind = excluded.kind,
          topic_id = excluded.topic_id,
          text = excluded.text,
          status = excluded.status,
          until_at = excluded.until_at,
          issued_at = excluded.issued_at,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        record.reminderId,
        record.kind,
        record.topicId,
        record.text,
        record.status,
        record.until,
        record.issuedAt,
        record.updatedAt,
      );
  }

  listReminders(): ReminderRecord[] {
    return this.#db
      .query<ReminderRow, []>(
        "SELECT * FROM reminders ORDER BY issued_at, reminder_id",
      )
      .all()
      .map(mapReminder);
  }

  #migrate(): void {
    let previous = 0;
    for (const migration of SCHEMA_MIGRATIONS) {
      if (!Number.isInteger(migration.version) || migration.version <= previous) {
        throw new Error("schema migrations must be strictly increasing");
      }
      previous = migration.version;
    }
    const apply = this.#db.transaction(() => {
      let current = this.schemaVersion();
      for (const migration of SCHEMA_MIGRATIONS) {
        if (migration.version <= current) continue;
        this.#db.exec(migration.sql);
        this.#db
          .query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
        this.#db.exec(`PRAGMA user_version = ${migration.version}`);
        current = migration.version;
      }
    });
    apply();
  }
}
