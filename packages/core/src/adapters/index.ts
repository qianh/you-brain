import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { applyCaptureRedaction } from "../capture/redact.js";
import type { NormalizedSession, SessionSource } from "../domain/session.js";
import { allowCapturePath } from "./filter.js";
import { parseClaudeSession } from "./claude.js";
import { parseCodexSession } from "./codex.js";
import { parseCursorSession } from "./cursor.js";
import { parseGeminiSession } from "./gemini.js";
import { globFiles } from "./glob.js";
import { parseGrokSession } from "./grok.js";
import type { AdapterResult, DiscoveryOptions, DiscoveryResult, DiscoveryStatus } from "./types.js";

export { parseClaudeSession, claudeAdapter } from "./claude.js";
export { parseCodexSession, codexAdapter } from "./codex.js";
export { parseCursorSession, cursorAdapter } from "./cursor.js";
export { parseGeminiSession, geminiAdapter } from "./gemini.js";
export { parseGrokSession, grokAdapter } from "./grok.js";
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

const emptyStatus = (): DiscoveryStatus => ({
  discovered: 0,
  captured: 0,
  skippedSubagents: 0,
  malformed: 0,
  errors: 0,
});

async function incrementalFiles(
  paths: string[],
  modifiedAfter: string | undefined,
  includePaths: Set<string>,
  sourcePath: (path: string) => string = (path) => path,
): Promise<string[]> {
  if (!modifiedAfter) return paths;
  const candidates = await Promise.all(
    paths.map(async (path) => {
      if (includePaths.has(path) || includePaths.has(sourcePath(path)))
        return path;
      try {
        return (await stat(path)).mtime.toISOString() > modifiedAfter
          ? path
          : null;
      } catch {
        return path;
      }
    }),
  );
  return candidates.filter((path): path is string => path !== null);
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
  };
  const output: DiscoveryResult = {
    sessions: [],
    skippedSubagents: 0,
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
  };
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

  if (options.sources.includes("claude-code")) {
    const paths = visible(
      "claude-code",
      await incrementalFiles(
        await globFiles(
          options.paths.claude.map((root) => join(root, "**", "*.jsonl")),
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
  if (options.sources.includes("codex")) {
    const paths = visible(
      "codex",
      await incrementalFiles(
        await globFiles(
          options.paths.codex.map((root) => join(root, "**", "rollout-*.jsonl")),
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
  if (options.sources.includes("grok-build")) {
    const histories = visible(
      "grok-build",
      await incrementalFiles(
        await globFiles(
          options.paths.grok.map((root) =>
            join(root, "**", "chat_history.jsonl"),
          ),
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
  if (options.sources.includes("cursor")) {
    const paths = visible(
      "cursor",
      await incrementalFiles(
        await globFiles(
          options.paths.cursor.map((root) =>
            join(root, "**", "agent-transcripts", "*", "*.jsonl"),
          ),
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
  if (options.sources.includes("gemini-cli")) {
    const paths = visible(
      "gemini-cli",
      await incrementalFiles(
        await globFiles(
          (options.paths.gemini ?? []).map((root) =>
            join(root, "**", "chats", "session-*.json"),
          ),
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

  for (const item of work) {
    try {
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
      if (result.session) {
        status[item.name].captured += 1;
        output.sessions.push(result.session);
      }
    } catch {
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
