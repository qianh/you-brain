import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { applyCaptureRedaction } from "../capture/redact.js";
import { NormalizedSessionSchema, type Turn } from "../domain/session.js";
import { geminiProjectHash, isDedicatedCapturePath, llmCliWorkDir } from "../llm/cli/workdir.js";
import { resolveContinuation } from "./continuation.js";
import {
  mergeToolText,
  timestampBounds,
  toolTextFromCalls,
  visibleTurnContent,
} from "./content.js";
import { isConversation } from "./conversation.js";
import { globFiles } from "./glob.js";
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

function geminiVisibleContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.filter((value) => asRecord(value)?.thought !== true);
}

function geminiTurn(
  role: "user" | "assistant",
  message: Record<string, unknown>,
  options: AdapterOptions,
): Turn | null {
  const content = geminiVisibleContent(message.content);
  let turn = visibleTurnContent(role, content);
  if (Array.isArray(content)) {
    const untyped = content.flatMap((value) => {
      const part = asRecord(value);
      if (!part || asString(part.type) || part.thought === true) return [];
      const text = asString(part.text);
      return text ? [text] : [];
    });
    if (untyped.length > 0) {
      const extra = untyped.join("\n");
      turn = turn
        ? {
            ...turn,
            text: turn.text.length > 0 ? `${turn.text}\n${extra}` : extra,
          }
        : { role, text: extra, images: [] };
    }
  }
  if (options.keepToolCalls !== true) return turn;
  return mergeToolText(
    turn,
    role,
    toolTextFromCalls(message.toolCalls, toolCallLimit(options)),
  );
}

export async function parseGeminiSession(
  path: string,
  options: AdapterOptions,
): Promise<AdapterResult> {
  const workDir = options.llmCliWorkDir ?? llmCliWorkDir();
  if (isDedicatedCapturePath(path, workDir, geminiProjectHash)) {
    return { session: null, skippedSubagent: false, malformedLines: 0 };
  }
  const [text, fileStat] = await Promise.all([
    options.signal
      ? readFile(path, { encoding: "utf8", signal: options.signal })
      : readFile(path, "utf8"),
    stat(path),
  ]);
  const record = asRecord(JSON.parse(text) as unknown);
  if (!record) {
    return { session: null, skippedSubagent: false, malformedLines: 1 };
  }
  const kind = asString(record.kind) ?? asString(record.session_kind);
  if (kind === "subagent" && !options.includeSubagents) {
    return { session: null, skippedSubagent: true, malformedLines: 0 };
  }

  const turns: Turn[] = [];
  const timestamps: Array<string | null> = [];
  const messages = Array.isArray(record.messages) ? record.messages : [];
  for (const value of messages) {
    const message = asRecord(value);
    if (!message) continue;
    timestamps.push(asString(message.timestamp));
    const type = asString(message.type);
    if (type !== "user" && type !== "gemini") continue;
    const role = type === "user" ? "user" : "assistant";
    const turn = geminiTurn(role, message, options);
    if (turn) turns.push(turn);
  }

  if (!isConversation(turns)) {
    return { session: null, skippedSubagent: false, skippedNoise: true, malformedLines: 0 };
  }
  const bounds = timestampBounds(
    [asString(record.startTime), asString(record.lastUpdated), ...timestamps],
    fileStat.mtime.toISOString(),
  );
  const session = NormalizedSessionSchema.parse({
    source: "gemini-cli",
    conversationId: asString(record.sessionId) ?? basename(path, ".json"),
    device: options.device,
    ...bounds,
    turns,
    sourcePath: path,
    warnings: [],
  });
  return { session, skippedSubagent: false, malformedLines: 0 };
}

export const geminiAdapter: SourceAdapter = {
  id: "gemini-cli",
  defaultRoots(homeDir = homedir()) {
    return [join(homeDir, ".gemini", "tmp")];
  },
  async *discover(roots: string[]): AsyncIterable<SourceFile> {
    const paths = await globFiles(
      roots.map((root) => join(root, "**", "chats", "session-*.json")),
    );
    for (const path of paths) yield { path, source: "gemini-cli" };
  },
  async parse(file, opts) {
    const result = await parseGeminiSession(file.path, adapterOptions(opts));
    if (!result.session) return [];
    return [
      applyCaptureRedaction(result.session, resolveCaptureOptions(opts)).session,
    ];
  },
  continuationOf(session, known = []) {
    return resolveContinuation(session, known);
  },
};
