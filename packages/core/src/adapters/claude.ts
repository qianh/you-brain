import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { applyCaptureRedaction } from "../capture/redact.js";
import { NormalizedSessionSchema, type Turn } from "../domain/session.js";
import { claudeProjectKey, isDedicatedCapturePath, llmCliWorkDir } from "../llm/cli/workdir.js";
import {
  mergeToolText,
  timestampBounds,
  toolTextFromContent,
  visibleTurnContent,
} from "./content.js";
import { isConversation } from "./conversation.js";
import { globFiles } from "./glob.js";
import { asRecord, asString, forEachJsonLine } from "./jsonl.js";
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
  const workDir = options.llmCliWorkDir ?? llmCliWorkDir();
  if (isDedicatedCapturePath(path, workDir, claudeProjectKey)) {
    return { session: null, skippedSubagent: false, malformedLines: 0 };
  }
  const turns: Turn[] = [];
  const timestamps: Array<string | null> = [];
  let conversationId: string | null = null;
  let sidechain = false;
  const keepTools = options.keepToolCalls === true;
  const maxChars = toolCallLimit(options);
  const [{ malformedLines }, fileStat] = await Promise.all([
    forEachJsonLine(
      path,
      (value) => {
        const record = asRecord(value);
        if (!record) return;
        if (record.isSidechain === true) sidechain = true;
        conversationId ??= asString(record.sessionId);
        timestamps.push(asString(record.timestamp));
        if (sidechain && !options.includeSubagents) {
          turns.length = 0;
          return;
        }
        if (record.type !== "user" && record.type !== "assistant") return;
        const message = asRecord(record.message);
        if (!message) return;
        const role = message.role;
        if (role !== "user" && role !== "assistant") return;
        const turn = keepTools
          ? mergeToolText(
              visibleTurnContent(role, message.content),
              role,
              toolTextFromContent(message.content, maxChars),
            )
          : visibleTurnContent(role, message.content);
        if (turn) turns.push(turn);
      },
      options.signal,
    ),
    stat(path),
  ]);
  if (sidechain && !options.includeSubagents) {
    return { session: null, skippedSubagent: true, malformedLines };
  }

  if (!conversationId || !isConversation(turns)) {
    return { session: null, skippedSubagent: false, skippedNoise: true, malformedLines };
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
