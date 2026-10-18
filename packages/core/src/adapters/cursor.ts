import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { applyCaptureRedaction } from "../capture/redact.js";
import { NormalizedSessionSchema, type Turn } from "../domain/session.js";
import { resolveContinuation } from "./continuation.js";
import {
  mergeToolText,
  timestampBounds,
  toolTextFromContent,
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

const userQueryPattern = /<user_query>([\s\S]*?)<\/user_query>/gu;

function visibleUserQueryContent(content: unknown): unknown[] | null {
  if (!Array.isArray(content)) return null;
  const queries: Record<string, unknown>[] = [];
  const images: Record<string, unknown>[] = [];
  for (const value of content) {
    const part = asRecord(value);
    if (!part) continue;
    const type = asString(part.type);
    if (type === "text" || type === "input_text") {
      const text = asString(part.text);
      if (!text) continue;
      for (const match of text.matchAll(userQueryPattern)) {
        if (match[1]) queries.push({ ...part, text: match[1] });
      }
      continue;
    }
    if (type === "image" || type === "input_image" || part.image_url) {
      images.push(part);
    }
  }
  return queries.length > 0 ? [...queries, ...images] : null;
}

export async function parseCursorSession(
  path: string,
  options: AdapterOptions,
): Promise<AdapterResult> {
  const [{ records, malformedLines }, fileStat] = await Promise.all([
    readJsonLines(path),
    stat(path),
  ]);
  const turns: Turn[] = [];
  const keepTools = options.keepToolCalls === true;
  const maxChars = toolCallLimit(options);
  for (const value of records) {
    const record = asRecord(value);
    if (!record) continue;
    const role = asString(record.role);
    if (role !== "user" && role !== "assistant") continue;
    const message = asRecord(record.message);
    if (!message) continue;
    const content =
      role === "user"
        ? visibleUserQueryContent(message.content)
        : message.content;
    if (!content && !keepTools) continue;
    const visible = content ? visibleTurnContent(role, content) : null;
    const turn = keepTools
      ? mergeToolText(
          visible,
          role,
          toolTextFromContent(message.content, maxChars),
        )
      : visible;
    if (turn) turns.push(turn);
  }

  if (turns.length === 0) {
    return { session: null, skippedSubagent: false, malformedLines };
  }
  const bounds = timestampBounds(
    [
      fileStat.birthtimeMs > 0 ? fileStat.birthtime.toISOString() : null,
      fileStat.mtime.toISOString(),
    ],
    fileStat.mtime.toISOString(),
  );
  const session = NormalizedSessionSchema.parse({
    source: "cursor",
    conversationId: basename(path, ".jsonl"),
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

export const cursorAdapter: SourceAdapter = {
  id: "cursor",
  defaultRoots(homeDir = homedir()) {
    return [join(homeDir, ".cursor", "projects")];
  },
  async *discover(roots: string[]): AsyncIterable<SourceFile> {
    const paths = await globFiles(
      roots.map((root) =>
        join(root, "**", "agent-transcripts", "*", "*.jsonl"),
      ),
    );
    for (const path of paths) yield { path, source: "cursor" };
  },
  async parse(file, opts) {
    const result = await parseCursorSession(file.path, adapterOptions(opts));
    if (!result.session) return [];
    return [
      applyCaptureRedaction(result.session, resolveCaptureOptions(opts)).session,
    ];
  },
  continuationOf(session, known = []) {
    return resolveContinuation(session, known);
  },
};
