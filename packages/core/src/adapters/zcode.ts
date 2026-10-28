import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

import { applyCaptureRedaction } from "../capture/redact.js";
import { NormalizedSessionSchema, type Turn } from "../domain/session.js";
import { isDedicatedCwd, llmCliWorkDir } from "../llm/cli/workdir.js";
import { formatToolCall, timestampBounds } from "./content.js";
import { isConversation } from "./conversation.js";
import { asRecord, asString } from "./jsonl.js";
import {
  adapterOptions,
  resolveCaptureOptions,
  toolCallLimit,
  type AdapterOptions,
  type AdapterResult,
  type SourceAdapter,
  type SourceFile,
} from "./types.js";

/**
 * ZCode keeps every conversation in one SQLite database
 * (`~/.zcode/cli/db/db.sqlite`), not in files. A `SourceFile` therefore points at
 * a row (`db.sqlite#<sessionId>`), and parsing opens the database read-only for
 * that session.
 *
 * Each `message` row is one step of the conversation: a user prompt, or one
 * assistant step. The visible text lives in `part` rows, interleaved with
 * `reasoning` (the model's private scratch space) and `tool` parts. Injected
 * context arrives as extra `user` messages marked `model-only` / hidden, so only
 * `real_user` prompts count as the user's own words.
 */
export function parseZcodePath(path: string): { database: string; sessionId: string } | null {
  const at = path.indexOf("#");
  if (at <= 0) return null;
  const database = path.slice(0, at);
  const sessionId = path.slice(at + 1);
  return sessionId.length > 0 ? { database, sessionId } : null;
}

export function zcodeSourcePath(database: string, sessionId: string): string {
  return `${database}#${sessionId}`;
}

function isoFromMs(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : null;
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    return asRecord(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

interface MessageRow {
  message_id: string;
  created: number;
  message: string;
  part: string | null;
}

interface MessageGroup {
  messageId: string;
  created: number;
  data: Record<string, unknown> | null;
  parts: Array<Record<string, unknown>>;
}

const empty = (): AdapterResult => ({
  session: null,
  skippedSubagent: false,
  malformedLines: 0,
});

export async function parseZcodeSession(
  path: string,
  options: AdapterOptions,
): Promise<AdapterResult> {
  const target = parseZcodePath(path);
  if (!target) return empty();
  let database: Database;
  try {
    database = new Database(target.database, { readonly: true });
  } catch {
    return { ...empty(), malformedLines: 1 };
  }
  try {
    const session = database
      .query<
        {
          id: string;
          parent_id: string | null;
          directory: string | null;
          time_created: number;
          time_updated: number;
        },
        [string]
      >(
        `
        SELECT id, parent_id, directory, time_created, time_updated
        FROM session
        WHERE id = ? AND time_deleted IS NULL
      `,
      )
      .get(target.sessionId);
    if (!session) return empty();
    // A child session is a subagent run started by the parent conversation.
    if (session.parent_id !== null && !options.includeSubagents) {
      return { ...empty(), skippedSubagent: true };
    }
    if (isDedicatedCwd(session.directory, options.llmCliWorkDir ?? llmCliWorkDir())) {
      return empty();
    }
    const rows = database
      .query<MessageRow, [string]>(
        `
        SELECT m.id AS message_id, m.time_created AS created, m.data AS message, p.data AS part
        FROM message m
        LEFT JOIN part p ON p.message_id = m.id
        WHERE m.session_id = ?
        ORDER BY m.sequence ASC, m.time_created ASC, m.id ASC, p.sequence ASC, p.id ASC
      `,
      )
      .all(target.sessionId);
    const groups: MessageGroup[] = [];
    for (const row of rows) {
      let group = groups.at(-1);
      if (!group || group.messageId !== row.message_id) {
        group = {
          messageId: row.message_id,
          created: row.created,
          data: parseJson(row.message),
          parts: [],
        };
        groups.push(group);
      }
      const part = parseJson(row.part);
      if (part) group.parts.push(part);
    }

    const keepTools = options.keepToolCalls === true;
    const maxChars = toolCallLimit(options);
    const turns: Turn[] = [];
    const timestamps: Array<string | null> = [
      isoFromMs(session.time_created),
      isoFromMs(session.time_updated),
    ];
    for (const group of groups) {
      timestamps.push(isoFromMs(group.created));
      const data = group.data;
      const role = asString(data?.role);
      if (role !== "user" && role !== "assistant") continue;
      const semantics = asRecord(data?.semantics);
      const metadata = asRecord(data?.metadata);
      const origin = asString(semantics?.origin);
      // Injected context, reminders, and timeline events are not conversation text.
      if (metadata?.visibility === "model-only") continue;
      if (asString(semantics?.transcriptVisibility) === "hidden") continue;
      if (origin === "system") continue;
      if (role === "user" && origin !== undefined && origin !== "real_user") continue;
      const lines: string[] = [];
      for (const part of group.parts) {
        const type = asString(part.type);
        if (type === "text") {
          const text = asString(part.text);
          if (text !== null && text.trim() !== "") lines.push(text);
          continue;
        }
        if (keepTools && type === "tool") {
          const state = asRecord(part.state);
          const line = formatToolCall(
            asString(part.tool) ?? "tool",
            state?.input ?? part.input,
            maxChars,
          );
          if (line !== "") lines.push(line);
        }
      }
      if (lines.length === 0) continue;
      turns.push({
        role,
        text: lines.join("\n"),
        images: [],
      });
    }
    if (!isConversation(turns)) {
      return { ...empty(), skippedNoise: true };
    }
    const bounds = timestampBounds(
      timestamps,
      isoFromMs(session.time_updated) ?? new Date(0).toISOString(),
    );
    const parsed = NormalizedSessionSchema.parse({
      source: "zcode",
      conversationId: target.sessionId,
      device: options.device,
      ...bounds,
      turns,
      sourcePath: path,
      warnings: [],
    });
    return { session: parsed, skippedSubagent: false, malformedLines: 0 };
  } finally {
    database.close();
  }
}

/** Live session ids in the database, so `discover` can stay incremental by file. */
function listSessions(database: string): string[] {
  let db: Database;
  try {
    db = new Database(database, { readonly: true });
  } catch {
    return [];
  }
  try {
    return db
      .query<{ id: string }, []>(
        `SELECT id FROM session WHERE time_deleted IS NULL ORDER BY time_updated ASC`,
      )
      .all()
      .map((row) => row.id);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export const zcodeAdapter: SourceAdapter = {
  id: "zcode",
  defaultRoots(homeDir = homedir()) {
    return [join(homeDir, ".zcode", "cli", "db")];
  },
  async *discover(roots: string[]): AsyncIterable<SourceFile> {
    for (const root of roots) {
      const database = join(root, "db.sqlite");
      for (const sessionId of listSessions(database)) {
        yield { path: zcodeSourcePath(database, sessionId), source: "zcode" };
      }
    }
  },
  async parse(file, opts) {
    const result = await parseZcodeSession(file.path, adapterOptions(opts));
    if (!result.session) return [];
    return [applyCaptureRedaction(result.session, resolveCaptureOptions(opts)).session];
  },
};
