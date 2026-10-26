import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { applyCaptureRedaction } from "../capture/redact.js";
import { NormalizedSessionSchema, type Turn } from "../domain/session.js";
import { isDedicatedCwd, llmCliWorkDir } from "../llm/cli/workdir.js";
import { mergeToolText, timestampBounds, toolTextFromContent, visibleTurnContent } from "./content.js";
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

/**
 * Pi writes one JSONL per session under `~/.pi/agent/sessions/<encoded cwd>/`.
 * Every line is an event; only `message` events carry conversation turns.
 * `system`, `thinking` and `toolCall` parts are not conversation text, and
 * `toolResult` lines are tool output, so they follow the same rules as the
 * other adapters: visible user/assistant text only, tool calls on request.
 */
export async function parsePiSession(
  path: string,
  options: AdapterOptions,
): Promise<AdapterResult> {
  const turns: Turn[] = [];
  const timestamps: Array<string | null> = [];
  const meta = { id: null as string | null, cwd: null as string | null, timestamp: null as string | null };
  const keepTools = options.keepToolCalls === true;
  const maxChars = toolCallLimit(options);
  const [{ malformedLines }, fileStat] = await Promise.all([
    forEachJsonLine(
      path,
      (value) => {
        const record = asRecord(value);
        if (!record) return;
        timestamps.push(asString(record.timestamp));
        if (record.type === "session") {
          meta.id ??= asString(record.id);
          meta.cwd ??= asString(record.cwd);
          meta.timestamp ??= asString(record.timestamp);
          return;
        }
        if (record.type !== "message") return;
        const message = asRecord(record.message);
        const role = asString(message?.role);
        if (!message || (role !== "user" && role !== "assistant")) return;
        const turn = visibleTurnContent(role, message.content);
        if (keepTools) {
          const withTools = mergeToolText(
            turn,
            role,
            toolTextFromContent(message.content, maxChars),
          );
          if (withTools) turns.push(withTools);
          return;
        }
        if (turn) turns.push(turn);
      },
      options.signal,
    ),
    stat(path),
  ]);
  if (isDedicatedCwd(meta.cwd, options.llmCliWorkDir ?? llmCliWorkDir())) {
    return { session: null, skippedSubagent: false, malformedLines };
  }
  if (!isConversation(turns)) {
    return { session: null, skippedSubagent: false, skippedNoise: true, malformedLines };
  }
  // `<timestamp>_<sessionId>.jsonl`: the id is already on the first line, but older
  // files may predate it, so the filename is the fallback.
  const conversationId = meta.id ?? piFileId(path);
  const bounds = timestampBounds(
    [meta.timestamp, ...timestamps],
    fileStat.mtime.toISOString(),
  );
  const session = NormalizedSessionSchema.parse({
    source: "pi",
    conversationId,
    device: options.device,
    ...bounds,
    turns,
    sourcePath: path,
    warnings:
      malformedLines > 0 ? [`Ignored ${malformedLines} malformed JSONL line(s)`] : [],
  });
  return { session, skippedSubagent: false, malformedLines };
}

/** `2026-10-18T07-51-13-253Z_01a14dfe-4a64-73a9-a0ba-e83820309b2c.jsonl` */
function piFileId(path: string): string {
  const name = basename(path, ".jsonl");
  const separator = name.indexOf("_");
  return separator >= 0 ? name.slice(separator + 1) : name;
}

export const piAdapter: SourceAdapter = {
  id: "pi",
  defaultRoots(homeDir = homedir()) {
    return [join(homeDir, ".pi", "agent", "sessions")];
  },
  async *discover(roots: string[]): AsyncIterable<SourceFile> {
    const paths = await globFiles(roots.map((root) => join(root, "**", "*.jsonl")));
    for (const path of paths) yield { path, source: "pi" };
  },
  async parse(file, opts) {
    const result = await parsePiSession(file.path, adapterOptions(opts));
    if (!result.session) return [];
    return [applyCaptureRedaction(result.session, resolveCaptureOptions(opts)).session];
  },
};
