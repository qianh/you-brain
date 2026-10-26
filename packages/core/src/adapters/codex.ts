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
import { isConversation } from "./conversation.js";
import { globFiles } from "./glob.js";
import { asRecord, asString, forEachJsonLine } from "./jsonl.js";
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
  const turns: Turn[] = [];
  const timestamps: Array<string | null> = [];
  const meta = { payload: null as Record<string, unknown> | null };
  const keepTools = options.keepToolCalls === true;
  const maxChars = toolCallLimit(options);
  const [{ malformedLines }, fileStat] = await Promise.all([
    forEachJsonLine(
      path,
      (value) => {
        const record = asRecord(value);
        if (!record) return;
        timestamps.push(asString(record.timestamp));
        if (record.type === "session_meta" && !meta.payload) {
          meta.payload = asRecord(record.payload);
        }
        if (record.type !== "response_item") return;
        const payload = asRecord(record.payload);
        if (keepTools && payload?.type === "function_call") {
          const line = formatToolCall(
            asString(payload.name) ?? "tool",
            payload.arguments ?? payload.input ?? payload.args,
            maxChars,
          );
          if (!line) return;
          const previous = turns.at(-1);
          if (previous?.role === "assistant") {
            previous.text = previous.text.length > 0 ? `${previous.text}\n\n${line}` : line;
          } else {
            turns.push({ role: "assistant", text: line, images: [] });
          }
          return;
        }
        if (payload?.type !== "message") return;
        const role = payload.role;
        if (role !== "user" && role !== "assistant") return;
        const turn = visibleTurnContent(role, payload.content);
        if (turn) turns.push(turn);
      },
      options.signal,
    ),
    stat(path),
  ]);
  const metaPayload = meta.payload;
  const isSubagent = asRecord(metaPayload?.source)?.subagent !== undefined;
  if (isSubagent && !options.includeSubagents) {
    return { session: null, skippedSubagent: true, malformedLines };
  }
  if (isDedicatedCwd(asString(metaPayload?.cwd), options.llmCliWorkDir ?? llmCliWorkDir())) {
    return { session: null, skippedSubagent: false, malformedLines };
  }

  const conversationId = asString(metaPayload?.id) ?? basename(path, ".jsonl");
  if (!isConversation(turns)) {
    return { session: null, skippedSubagent: false, skippedNoise: true, malformedLines };
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
