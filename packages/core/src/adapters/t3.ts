import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

import { applyCaptureRedaction } from "../capture/redact.js";
import { NormalizedSessionSchema, type Turn } from "../domain/session.js";
import { isDedicatedCwd, llmCliWorkDir } from "../llm/cli/workdir.js";
import { isConversation } from "./conversation.js";
import { timestampBounds } from "./content.js";
import {
  adapterOptions,
  resolveCaptureOptions,
  type AdapterOptions,
  type AdapterResult,
  type SourceAdapter,
  type SourceFile,
} from "./types.js";

/**
 * T3 Code keeps its transcripts in one SQLite database, not in files. A
 * `SourceFile` therefore points at a row (`db.sqlite#<threadId>`), and parsing
 * opens the database read-only for that thread.
 *
 * Threads whose id starts with `import:` were imported from another tool by T3.
 * The original CLI already has them, so capturing both would double every turn.
 */
const IMPORTED_PREFIX = "import:";

export function isImportedThread(threadId: string): boolean {
  return threadId.startsWith(IMPORTED_PREFIX);
}

interface MessageRow {
  role: string;
  text: string;
  created_at: string;
}

export function parseT3Path(path: string): { database: string; threadId: string } | null {
  const at = path.indexOf("#");
  if (at <= 0) return null;
  const database = path.slice(0, at);
  const threadId = path.slice(at + 1);
  return threadId.length > 0 ? { database, threadId } : null;
}

export function t3SourcePath(database: string, threadId: string): string {
  return `${database}#${threadId}`;
}

export async function parseT3Session(
  path: string,
  options: AdapterOptions,
): Promise<AdapterResult> {
  const target = parseT3Path(path);
  if (!target) return { session: null, skippedSubagent: false, malformedLines: 0 };
  if (isImportedThread(target.threadId)) {
    return { session: null, skippedSubagent: false, malformedLines: 0 };
  }
  let database: Database;
  try {
    database = new Database(target.database, { readonly: true });
  } catch {
    return { session: null, skippedSubagent: false, malformedLines: 1 };
  }
  try {
    const thread = database
      .query<{ title: string; created_at: string; updated_at: string; worktree_path: string | null }, [string]>(
        `
        SELECT t.title, t.created_at, t.updated_at, t.worktree_path
        FROM projection_threads t
        WHERE t.thread_id = ? AND t.deleted_at IS NULL
      `,
      )
      .get(target.threadId);
    if (!thread) return { session: null, skippedSubagent: false, malformedLines: 0 };
    if (isDedicatedCwd(thread.worktree_path, options.llmCliWorkDir ?? llmCliWorkDir())) {
      return { session: null, skippedSubagent: false, malformedLines: 0 };
    }
    // `reasoning` rows are the model's private scratch space, not conversation text.
    const rows = database
      .query<MessageRow, [string]>(
        `
        SELECT role, text, created_at
        FROM projection_thread_messages
        WHERE thread_id = ? AND role IN ('user', 'assistant')
        ORDER BY created_at ASC, message_id ASC
      `,
      )
      .all(target.threadId);
    const turns: Turn[] = [];
    for (const row of rows) {
      const text = row.text.trim();
      if (text.length === 0) continue;
      turns.push({
        role: row.role === "user" ? "user" : "assistant",
        text,
        images: [],
      });
    }
    if (!isConversation(turns)) {
      return { session: null, skippedSubagent: false, skippedNoise: true, malformedLines: 0 };
    }
    const bounds = timestampBounds(
      [thread.created_at, thread.updated_at, ...rows.map((row) => row.created_at)],
      thread.updated_at,
    );
    const session = NormalizedSessionSchema.parse({
      source: "t3-code",
      conversationId: target.threadId,
      device: options.device,
      ...bounds,
      turns,
      sourcePath: path,
      warnings: [],
    });
    return { session, skippedSubagent: false, malformedLines: 0 };
  } finally {
    database.close();
  }
}

/** Thread ids in the database, so `discover` can stay incremental by file. */
function listThreads(database: string): Array<{ threadId: string; updatedAt: string }> {
  let db: Database;
  try {
    db = new Database(database, { readonly: true });
  } catch {
    return [];
  }
  try {
    return db
      .query<{ thread_id: string; updated_at: string }, []>(
        `
        SELECT thread_id, updated_at
        FROM projection_threads
        WHERE deleted_at IS NULL
        ORDER BY updated_at ASC
      `,
      )
      .all()
      .filter((row) => !isImportedThread(row.thread_id))
      .map((row) => ({ threadId: row.thread_id, updatedAt: row.updated_at }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export const t3Adapter: SourceAdapter = {
  id: "t3-code",
  defaultRoots(homeDir = homedir()) {
    return [join(homeDir, ".t3", "userdata")];
  },
  async *discover(roots: string[]): AsyncIterable<SourceFile> {
    for (const root of roots) {
      const database = join(root, "state.sqlite");
      for (const thread of listThreads(database)) {
        yield { path: t3SourcePath(database, thread.threadId), source: "t3-code" };
      }
    }
  },
  async parse(file, opts) {
    const result = await parseT3Session(file.path, adapterOptions(opts));
    if (!result.session) return [];
    return [applyCaptureRedaction(result.session, resolveCaptureOptions(opts)).session];
  },
};
