import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { applyCaptureRedaction } from "../capture/redact.js";
import { NormalizedSessionSchema, type Turn } from "../domain/session.js";
import {
  mergeToolText,
  timestampBounds,
  toolTextFromContent,
  visibleTurnContent,
} from "./content.js";
import { globFiles } from "./glob.js";
import { asRecord, asString, readJsonLines } from "./jsonl.js";
import { resolveContinuation } from "./continuation.js";
import {
  adapterOptions,
  resolveCaptureOptions,
  toolCallLimit,
  type AdapterOptions,
  type AdapterResult,
  type SourceAdapter,
  type SourceFile,
} from "./types.js";

export async function parseClaudeSession(
  path: string,
  options: AdapterOptions,
): Promise<AdapterResult> {
  const [{ records, malformedLines }, fileStat] = await Promise.all([
    readJsonLines(path),
    stat(path),
  ]);
  const objects = records.map(asRecord).filter((value) => value !== null);
  const isSidechain = objects.some((record) => record.isSidechain === true);
  if (isSidechain && !options.includeSubagents) {
    return { session: null, skippedSubagent: true, malformedLines };
  }

  const turns: Turn[] = [];
  const timestamps: Array<string | null> = [];
  let conversationId: string | null = null;
  const keepTools = options.keepToolCalls === true;
  const maxChars = toolCallLimit(options);
  for (const record of objects) {
    conversationId ??= asString(record.sessionId);
    timestamps.push(asString(record.timestamp));
    if (record.type !== "user" && record.type !== "assistant") continue;
    const message = asRecord(record.message);
    if (!message) continue;
    const role = message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const turn = keepTools
      ? mergeToolText(
          visibleTurnContent(role, message.content),
          role,
          toolTextFromContent(message.content, maxChars),
        )
      : visibleTurnContent(role, message.content);
    if (turn) turns.push(turn);
  }

  if (!conversationId || turns.length === 0) {
    return { session: null, skippedSubagent: false, malformedLines };
  }
  const bounds = timestampBounds(timestamps, fileStat.mtime.toISOString());
  const session = NormalizedSessionSchema.parse({
    source: "claude-code",
    conversationId,
    device: options.device,
    ...bounds,
    turns,
    sourcePath: path,
    warnings:
      malformedLines > 0
        ? [`Ignored ${malformedLines} malformed JSONL line(s)`]
        : [],
  });
  return { session, skippedSubagent: false, malformedLines };
}

export const claudeAdapter: SourceAdapter = {
  id: "claude-code",
  defaultRoots(homeDir = homedir()) {
    return [join(homeDir, ".claude", "projects")];
  },
  async *discover(roots: string[]): AsyncIterable<SourceFile> {
    const paths = await globFiles(
      roots.map((root) => join(root, "**", "*.jsonl")),
    );
    for (const path of paths) yield { path, source: "claude-code" };
  },
  async parse(file, opts) {
    const result = await parseClaudeSession(file.path, adapterOptions(opts));
    if (!result.session) return [];
    return [
      applyCaptureRedaction(result.session, resolveCaptureOptions(opts)).session,
    ];
  },
  continuationOf(session, known = []) {
    return resolveContinuation(session, known);
  },
};
