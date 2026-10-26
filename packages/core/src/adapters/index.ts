import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Database } from "bun:sqlite";

import { applyCaptureRedaction } from "../capture/redact.js";
import type { NormalizedSession, SessionSource } from "../domain/session.js";
import { allowCapturePath } from "./filter.js";
import { parseClaudeSession } from "./claude.js";
import { parseCodexSession } from "./codex.js";
import { parseCursorSession } from "./cursor.js";
import { parseGeminiSession } from "./gemini.js";
import { globFiles } from "./glob.js";
import { parseGrokSession } from "./grok.js";
import { parsePiSession } from "./pi.js";
import { isImportedThread, parseT3Session, t3SourcePath } from "./t3.js";
import type {
  AdapterOptions,
  AdapterResult,
  DiscoveryOptions,
  DiscoveryResult,
  DiscoveryStatus,
} from "./types.js";

export { parseClaudeSession, claudeAdapter } from "./claude.js";
export { parseCodexSession, codexAdapter } from "./codex.js";
export { parseCursorSession, cursorAdapter } from "./cursor.js";
export { parseGeminiSession, geminiAdapter } from "./gemini.js";
export { parseGrokSession, grokAdapter } from "./grok.js";
export { parsePiSession, piAdapter } from "./pi.js";
export { parseT3Session, t3Adapter, isImportedThread, parseT3Path } from "./t3.js";
export {
  clearContinuationIndex,
  continuationByPrefix,
  messagePrefixHash,
  rememberContinuation,
  resolveContinuation,
  DEFAULT_CONTINUATION_PREFIX_TURNS,
} from "./continuation.js";
export {
  continuationOf,
  getAdapter,
  listAdapters,
  registerAdapter,
  unregisterAdapter,
} from "./registry.js";
export { isConversation, isInjectedPrompt } from "./conversation.js";
export { allowCapturePath, captureSourceFilters, globToRegExp } from "./filter.js";
export type { CapturePathFilter } from "./filter.js";
export {
  adapterOptions,
  resolveCaptureOptions,
  DEFAULT_TOOL_CALL_MAX_CHARS,
} from "./types.js";
export type {
  AdapterOptions,
  AdapterResult,
  CaptureOptions,
  DiscoveryOptions,
  DiscoveryResult,
  DiscoveryStatus,
  ResolvedCaptureOptions,
  SourceAdapter,
  SourceFile,
} from "./types.js";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

const emptyStatus = (): DiscoveryStatus => ({
  discovered: 0,
  captured: 0,
  skippedSubagents: 0,
  skippedNoise: 0,
  malformed: 0,
  errors: 0,
});
async function incrementalFiles(
  paths: string[] | Promise<string[]>,
  modifiedAfter: string | undefined,
  includePaths: Set<string>,
  sourcePath: (path: string) => string = (path) => path,
): Promise<string[]> {
  const listed = await paths;
  if (!modifiedAfter) return listed;
  const candidates = await Promise.all(
    listed.map(async (path) => {
      if (includePaths.has(path) || includePaths.has(sourcePath(path)))
        return path;
      try {
        // A row-backed path (`<database>#<row>`) is stamped by its database file.
        const at = path.indexOf("#");
        return (await stat(at > 0 ? path.slice(0, at) : path)).mtime.toISOString() > modifiedAfter
          ? path
          : null;
      } catch {
        return path;
      }
    }),
  );
  return candidates.filter((path): path is string => path !== null);
}

/**
 * One path per live T3 thread. T3 keeps every transcript in one database, so the
 * unit of work is a row, not a file: `<database>#<threadId>`.
 */
async function t3ThreadPaths(roots: string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const root of roots) {
    const database = join(root, "state.sqlite");
    let db: Database;
    try {
      db = new Database(database, { readonly: true });
    } catch {
      continue;
    }
    try {
      const rows = db
        .query<{ thread_id: string }, []>(
          `SELECT thread_id FROM projection_threads WHERE deleted_at IS NULL`,
        )
        .all();
      for (const row of rows) {
        if (isImportedThread(row.thread_id)) continue;
        paths.push(t3SourcePath(database, row.thread_id));
      }
    } catch {
      // Not a T3 database, or an older schema without threads.
    } finally {
      db.close();
    }
  }
  return paths;
}

export async function discoverSessions(
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const status = {
    claude: emptyStatus(),
    codex: emptyStatus(),
    grok: emptyStatus(),
    cursor: emptyStatus(),
    gemini: emptyStatus(),
    pi: emptyStatus(),
    t3: emptyStatus(),
  };
  const output: DiscoveryResult = {
    sessions: [],
    skippedSubagents: 0,
    skippedNoise: 0,
    malformed: 0,
    warnings: [],
    status,
  };
  const parserOptions = {
    device: options.device,
    includeSubagents: options.includeSubagents,
    ...(options.keepToolCalls !== undefined ? { keepToolCalls: options.keepToolCalls } : {}),
    ...(options.toolCallMaxChars !== undefined
      ? { toolCallMaxChars: options.toolCallMaxChars }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const stopped = (): boolean => options.signal?.aborted === true;
  const includePaths = new Set(options.includePaths ?? []);
  const visible = (source: SessionSource, paths: string[]): string[] => {
    const filter = options.sourceFilters?.[source];
    if (!filter) return paths;
    return paths.filter((path) => allowCapturePath(path, filter.include, filter.exclude));
  };
  const work: Array<{
    name: keyof typeof status;
    path: string;
    parse: () => Promise<AdapterResult>;
  }> = [];

  if (!stopped() && options.sources.includes("claude-code")) {
    const paths = visible(
      "claude-code",
      await incrementalFiles(
        await globFiles(
          options.paths.claude.map((root) => join(root, "**", "*.jsonl")),
          options.signal,
        ),
        options.modifiedAfter?.["claude-code"],
        includePaths,
      ),
    );
    status.claude.discovered = paths.length;
    work.push(
      ...paths.map((path) => ({
        name: "claude" as const,
        path,
        parse: () => parseClaudeSession(path, parserOptions),
      })),
    );
  }
  if (!stopped() && options.sources.includes("codex")) {
    const paths = visible(
      "codex",
      await incrementalFiles(
        await globFiles(
          options.paths.codex.map((root) => join(root, "**", "rollout-*.jsonl")),
          options.signal,
        ),
        options.modifiedAfter?.codex,
        includePaths,
      ),
    );
    status.codex.discovered = paths.length;
    work.push(
      ...paths.map((path) => ({
        name: "codex" as const,
        path,
        parse: () => parseCodexSession(path, parserOptions),
      })),
    );
  }
  if (!stopped() && options.sources.includes("grok-build")) {
    const histories = visible(
      "grok-build",
      await incrementalFiles(
        await globFiles(
          options.paths.grok.map((root) =>
            join(root, "**", "chat_history.jsonl"),
          ),
          options.signal,
        ),
        options.modifiedAfter?.["grok-build"],
        includePaths,
        dirname,
      ),
    );
    status.grok.discovered = histories.length;
    work.push(
      ...histories.map((path) => ({
        name: "grok" as const,
        path: dirname(path),
        parse: () => parseGrokSession(dirname(path), parserOptions),
      })),
    );
  }
  if (!stopped() && options.sources.includes("cursor")) {
    const paths = visible(
      "cursor",
      await incrementalFiles(
        await globFiles(
          options.paths.cursor.map((root) =>
            join(root, "**", "agent-transcripts", "*", "*.jsonl"),
          ),
          options.signal,
        ),
        options.modifiedAfter?.cursor,
        includePaths,
      ),
    );
    status.cursor.discovered = paths.length;
    work.push(
      ...paths.map((path) => ({
        name: "cursor" as const,
        path,
        parse: () => parseCursorSession(path, parserOptions),
      })),
    );
  }
  if (!stopped() && options.sources.includes("gemini-cli")) {
    const paths = visible(
      "gemini-cli",
      await incrementalFiles(
        await globFiles(
          (options.paths.gemini ?? []).map((root) =>
            join(root, "**", "chats", "session-*.json"),
          ),
          options.signal,
        ),
        options.modifiedAfter?.["gemini-cli"],
        includePaths,
      ),
    );
    status.gemini.discovered = paths.length;
    work.push(
      ...paths.map((path) => ({
        name: "gemini" as const,
        path,
        parse: () => parseGeminiSession(path, parserOptions),
      })),
    );
  }
  if (!stopped() && options.sources.includes("pi")) {
    const paths = visible(
      "pi",
      await incrementalFiles(
        await globFiles(
          (options.paths.pi ?? []).map((root) => join(root, "**", "*.jsonl")),
          options.signal,
        ),
        options.modifiedAfter?.pi,
        includePaths,
      ),
    );
    status.pi.discovered = paths.length;
    work.push(
      ...paths.map((path) => ({
        name: "pi" as const,
        path,
        parse: () => parsePiSession(path, parserOptions),
      })),
    );
  }
  if (!stopped() && options.sources.includes("t3-code")) {
    // T3 lists its own threads: one row per session, not one file per directory.
    const paths = visible(
      "t3-code",
      await incrementalFiles(
        await t3ThreadPaths(options.paths.t3 ?? []),
        options.modifiedAfter?.["t3-code"],
        includePaths,
      ),
    );
    status.t3.discovered = paths.length;
    work.push(
      ...paths.map((path) => ({
        name: "t3" as const,
        path,
        parse: () => parseT3Session(path, parserOptions),
      })),
    );
  }

  const retainSessions = options.retainSessions !== false;
  for (const item of work) {
    if (stopped()) break;
    try {
      if (options.skipFile && (await options.skipFile(item.path))) continue;
      let result = await item.parse();
      if (result.session && options.redact !== undefined) {
        const redacted = applyCaptureRedaction(result.session, {
          redact: options.redact,
          redaction: options.redaction ?? {},
        });
        result = { ...result, session: redacted.session };
      }
      status[item.name].malformed += result.malformedLines;
      output.malformed += result.malformedLines;
      if (result.skippedSubagent) {
        status[item.name].skippedSubagents += 1;
        output.skippedSubagents += 1;
      }
      if (result.skippedNoise) {
        status[item.name].skippedNoise += 1;
        output.skippedNoise += 1;
      }
      if (result.session) status[item.name].captured += 1;
      if (options.onParsed) await options.onParsed(item.path, result.session);
      if (result.session && retainSessions) output.sessions.push(result.session);
    } catch (error) {
      if (stopped() || isAbortError(error)) break;
      status[item.name].errors += 1;
      output.warnings.push({
        code: "SOURCE_PARSE_FAILED",
        message: `${item.name} session could not be parsed: ${item.path}`,
      });
    }
  }
  output.sessions.sort((left, right) =>
    left.updatedAt.localeCompare(right.updatedAt),
  );
  return output;
}

export async function parseSourceFile(
  source: SessionSource,
  path: string,
  options: AdapterOptions,
): Promise<AdapterResult> {
  switch (source) {
    case "claude-code":
      return parseClaudeSession(path, options);
    case "codex":
      return parseCodexSession(path, options);
    case "grok-build":
      return parseGrokSession(path, options);
    case "cursor":
      return parseCursorSession(path, options);
    case "gemini-cli":
      return parseGeminiSession(path, options);
    case "pi":
      return parsePiSession(path, options);
    case "t3-code":
      return parseT3Session(path, options);
  }
}
