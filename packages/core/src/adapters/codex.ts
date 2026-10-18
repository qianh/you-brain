import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { applyCaptureRedaction } from "../capture/redact.js";
import { NormalizedSessionSchema, type Turn } from "../domain/session.js";
import { isDedicatedCwd, llmCliWorkDir } from "../llm/cli/workdir.js";
import { rememberContinuation, resolveContinuation } from "./continuation.js";
import {
  formatToolCall,
  timestampBounds,
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

export async function parseCodexSession(
  path: string,
  options: AdapterOptions,
): Promise<AdapterResult> {
  const [{ records, malformedLines }, fileStat] = await Promise.all([
    readJsonLines(path, options.signal),
    stat(path),
  ]);
  const objects = records.map(asRecord).filter((value) => value !== null);
  const metadata = objects.find((record) => record.type === "session_meta");
  const metaPayload = asRecord(metadata?.payload);
  const isSubagent = asRecord(metaPayload?.source)?.subagent !== undefined;
  if (isSubagent && !options.includeSubagents) {
    return { session: null, skippedSubagent: true, malformedLines };
  }
  if (isDedicatedCwd(asString(metaPayload?.cwd), options.llmCliWorkDir ?? llmCliWorkDir())) {
    return { session: null, skippedSubagent: false, malformedLines };
  }

  const turns: Turn[] = [];
  const timestamps: Array<string | null> = [];
  const keepTools = options.keepToolCalls === true;
  const maxChars = toolCallLimit(options);
  for (const record of objects) {
    timestamps.push(asString(record.timestamp));
    if (record.type !== "response_item") continue;
    const payload = asRecord(record.payload);
    if (keepTools && payload?.type === "function_call") {
      const line = formatToolCall(
        asString(payload.name) ?? "tool",
        payload.arguments ?? payload.input ?? payload.args,
        maxChars,
      );
      if (!line) continue;
      const previous = turns.at(-1);
      if (previous?.role === "assistant") {
        previous.text = previous.text.length > 0 ? `${previous.text}\n\n${line}` : line;
      } else {
        turns.push({ role: "assistant", text: line, images: [] });
      }
      continue;
    }
    if (payload?.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const turn = visibleTurnContent(role, payload.content);
    if (turn) turns.push(turn);
  }

  const conversationId = asString(metaPayload?.id) ?? basename(path, ".jsonl");
  if (turns.length === 0) {
    return { session: null, skippedSubagent: false, malformedLines };
  }
  const bounds = timestampBounds(
    [asString(metaPayload?.timestamp), ...timestamps],
    fileStat.mtime.toISOString(),
  );
  const session = NormalizedSessionSchema.parse({
    source: "codex",
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
  rememberContinuation(session, asString(metaPayload?.forked_from_id));
  return { session, skippedSubagent: false, malformedLines };
}

export const codexAdapter: SourceAdapter = {
  id: "codex",
  defaultRoots(homeDir = homedir()) {
    return [join(homeDir, ".codex", "sessions")];
  },
  async *discover(roots: string[]): AsyncIterable<SourceFile> {
    const paths = await globFiles(
      roots.map((root) => join(root, "**", "rollout-*.jsonl")),
    );
    for (const path of paths) yield { path, source: "codex" };
  },
  async parse(file, opts) {
    const result = await parseCodexSession(file.path, adapterOptions(opts));
    if (!result.session) return [];
    return [
      applyCaptureRedaction(result.session, resolveCaptureOptions(opts)).session,
    ];
  },
  continuationOf(session, known = []) {
    return resolveContinuation(session, known);
  },
};
