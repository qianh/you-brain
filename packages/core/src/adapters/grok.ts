import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { applyCaptureRedaction } from "../capture/redact.js";
import { NormalizedSessionSchema, type Turn } from "../domain/session.js";
import { isDedicatedCapturePath, llmCliWorkDir } from "../llm/cli/workdir.js";
import { rememberContinuation, resolveContinuation } from "./continuation.js";
import {
  mergeToolText,
  timestampBounds,
  toolTextFromCalls,
  visibleTurnContent,
} from "./content.js";
import { globFiles } from "./glob.js";
import { asRecord, asString, readJsonLines } from "./jsonl.js";
import {
  adapterOptions,
  resolveCaptureOptions,
  toolCallLimit,
  type AdapterOptions,
  type AdapterResult,
  type SourceAdapter,
  type SourceFile,
} from "./types.js";

export async function parseGrokSession(
  directory: string,
  options: AdapterOptions,
): Promise<AdapterResult> {
  const sessionDir = directory.endsWith("chat_history.jsonl")
    ? dirname(directory)
    : directory;
  if (
    isDedicatedCapturePath(sessionDir, options.llmCliWorkDir ?? llmCliWorkDir(), encodeURIComponent)
  ) {
    return { session: null, skippedSubagent: false, malformedLines: 0 };
  }
  const historyPath = join(sessionDir, "chat_history.jsonl");
  const [{ records, malformedLines }, summaryText, fileStat] =
    await Promise.all([
      readJsonLines(historyPath, options.signal),
      options.signal
        ? readFile(join(sessionDir, "summary.json"), { encoding: "utf8", signal: options.signal })
        : readFile(join(sessionDir, "summary.json"), "utf8"),
      stat(historyPath),
    ]);
  const summary = asRecord(JSON.parse(summaryText) as unknown);
  const isSubagent = summary?.session_kind === "subagent";
  if (isSubagent && !options.includeSubagents) {
    return { session: null, skippedSubagent: true, malformedLines };
  }

  const turns: Turn[] = [];
  const keepTools = options.keepToolCalls === true;
  const maxChars = toolCallLimit(options);
  for (const value of records) {
    const record = asRecord(value);
    if (!record || (record.type !== "user" && record.type !== "assistant"))
      continue;
    const turn = keepTools
      ? mergeToolText(
          visibleTurnContent(record.type, record.content),
          record.type,
          toolTextFromCalls(record.tool_calls, maxChars),
        )
      : visibleTurnContent(record.type, record.content);
    if (turn) turns.push(turn);
  }
  if (turns.length === 0) {
    return { session: null, skippedSubagent: false, malformedLines };
  }
  const bounds = timestampBounds(
    [asString(summary?.created_at), asString(summary?.updated_at)],
    fileStat.mtime.toISOString(),
  );
  const session = NormalizedSessionSchema.parse({
    source: "grok-build",
    conversationId: basename(sessionDir),
    device: options.device,
    ...bounds,
    turns,
    sourcePath: sessionDir,
    warnings:
      malformedLines > 0
        ? [`Ignored ${malformedLines} malformed JSONL line(s)`]
        : [],
  });
  rememberContinuation(session, asString(summary?.parent_session_id));
  return { session, skippedSubagent: false, malformedLines };
}

export const grokAdapter: SourceAdapter = {
  id: "grok-build",
  defaultRoots(homeDir = homedir()) {
    return [join(homeDir, ".grok", "sessions")];
  },
  async *discover(roots: string[]): AsyncIterable<SourceFile> {
    const paths = await globFiles(
      roots.map((root) => join(root, "**", "chat_history.jsonl")),
    );
    for (const path of paths) {
      yield { path: dirname(path), source: "grok-build" };
    }
  },
  async parse(file, opts) {
    const result = await parseGrokSession(file.path, adapterOptions(opts));
    if (!result.session) return [];
    return [
      applyCaptureRedaction(result.session, resolveCaptureOptions(opts)).session,
    ];
  },
  continuationOf(session, known = []) {
    return resolveContinuation(session, known);
  },
};
