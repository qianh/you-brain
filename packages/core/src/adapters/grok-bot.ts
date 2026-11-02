import { readFile, readdir, stat } from "node:fs/promises";
import { homedir as osHomedir, platform } from "node:os";
import { basename, join } from "node:path";

import type { NormalizedSession } from "../domain/session.js";
import type { AdapterResult, CaptureOptions, SourceAdapter, SourceFile } from "./types.js";

/**
 * Grok Bot（xAI 桌面应用）把线程数据落在 Electron 的 `sand-client-persistence`
 * 目录：每个 `*.blob` 是一份明文 JSON（`{"schemaVersion":n,"value":…}`）。
 * 线程转录的 `value.entries[]` 里，`kind:"message"` 的条目带 `role`、
 * `content` 和 `timestampMs`；UI 状态（侧栏、信息面板）也是 blob，但没有
 * `entries`。本适配器只认转录 blob。
 */

export function grokBotPersistenceRoot(homeDir: string = osHomedir()): string | null {
  if (platform() !== "darwin") return null;
  return join(homeDir, "Library", "Application Support", "Grok Bot", "sand-client-persistence");
}

export interface GrokBotTurn {
  role: "user" | "assistant";
  text: string;
  atMs: number | null;
}

interface BlobEntry {
  kind?: unknown;
  role?: unknown;
  content?: unknown;
  message?: unknown;
  timestampMs?: unknown;
  agentId?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function coerceEntryText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (!isRecord(value)) return null;
  // 结构化正文（{type:"text",content:"…"} 或 {content:"…"}）取 content。
  if (typeof value.content === "string") return coerceEntryText(value.content);
  return null;
}

function coerceRole(value: unknown): "user" | "assistant" | null {
  return value === "user" || value === "assistant" ? value : null;
}

/** 从一份 blob JSON 里抽转录 turns；不是转录 blob 返回空数组。 */
export function grokBotTurns(value: unknown): GrokBotTurn[] {
  if (!isRecord(value)) return [];
  const entries = value.entries;
  if (!Array.isArray(entries)) return [];
  const turns: GrokBotTurn[] = [];
  for (const raw of entries) {
    if (!isRecord(raw)) continue;
    const entry = raw as BlobEntry;
    const role = coerceRole(entry.role);
    const text = coerceEntryText(entry.content) ?? coerceEntryText(entry.message);
    if (!role || text === null) continue;
    turns.push({ role, text, atMs: coerceTimestampMs(entry.timestampMs) });
  }
  return turns;
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

/** 解析单个 blob。不是转录（UI 状态、外发队列）返回 session:null。 */
export async function parseGrokBotBlob(
  path: string,
  options: CaptureOptions,
): Promise<AdapterResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { session: null, skippedSubagent: false, malformedLines: 1 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { session: null, skippedSubagent: false, malformedLines: 1 };
  }
  const turns = grokBotTurns(isRecord(parsed) ? parsed.value ?? parsed : parsed);
  if (turns.length === 0) {
    return { session: null, skippedSubagent: false, malformedLines: 0 };
  }
  let statMs: number | null = null;
  try {
    statMs = (await stat(path)).mtimeMs;
  } catch {
    statMs = null;
  }
  const stamps = turns.map((turn) => turn.atMs).filter((ms): ms is number => ms !== null);
  const isRecordValue = isRecord(parsed) ? parsed.value ?? parsed : null;
  const persistedAt =
    isRecordValue && isRecord(isRecordValue) && "persistedAt" in isRecordValue
      ? coerceTimestampMs((isRecordValue as Record<string, unknown>).persistedAt)
      : null;
  const startMs = stamps.length > 0 ? Math.min(...stamps) : (statMs ?? 0);
  const endMs =
    stamps.length > 0
      ? Math.max(...stamps)
      : (persistedAt ?? statMs ?? startMs);
  if (startMs <= 0) {
    return { session: null, skippedSubagent: false, malformedLines: 0 };
  }
  const startedAt = isoFromMs(startMs);
  const updatedAt = isoFromMs(Math.max(endMs, startMs));
  const session: NormalizedSession = {
    source: "grok-bot",
    conversationId: basename(path).replace(/\.blob$/u, ""),
    device: options.device,
    startedAt,
    updatedAt,
    turns: turns.map((turn) => ({
      role: turn.role,
      text: turn.text,
      images: [],
    })),
    sourcePath: path,
    warnings: [],
  };
  return { session, skippedSubagent: false, malformedLines: 0 };
}

export const grokBotAdapter: SourceAdapter = {
  id: "grok-bot",
  defaultRoots(homeDir?: string): string[] {
    const root = grokBotPersistenceRoot(homeDir);
    return root === null ? [] : [root];
  },
  async *discover(roots: string[]): AsyncIterable<SourceFile> {
    for (const root of roots) {
      let names: string[];
      try {
        names = await readdir(root);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".blob")) continue;
        yield { path: join(root, name), source: grokBotAdapter.id };
      }
    }
  },
  parse(file: SourceFile, opts: CaptureOptions): Promise<NormalizedSession[]> {
    return parseGrokBotBlob(file.path, opts).then((result) =>
      result.session === null ? [] : [result.session],
    );
  },
};

/** 指挥台 GUI 桥回收与探测脚本用：读出本机全部 Grok Bot 转录，新→旧。 */
export async function readGrokBotTranscripts(homeDir?: string): Promise<
  Array<{ conversationId: string; path: string; turns: GrokBotTurn[]; updatedAtMs: number }>
> {
  const root = grokBotPersistenceRoot(homeDir);
  if (root === null) return [];
  const out: Array<{
    conversationId: string;
    path: string;
    turns: GrokBotTurn[];
    updatedAtMs: number;
  }> = [];
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".blob")) continue;
    const path = join(root, name);
    try {
      const raw = await readFile(path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const value = isRecord(parsed) ? (parsed.value ?? parsed) : null;
      const turns = grokBotTurns(value);
      if (turns.length === 0) continue;
      const stamps = turns.map((turn) => turn.atMs).filter((ms): ms is number => ms !== null);
      const updatedAtMs =
        stamps.length > 0 ? Math.max(...stamps) : (await stat(path)).mtimeMs;
      out.push({
        conversationId: name.replace(/\.blob$/u, ""),
        path,
        turns,
        updatedAtMs,
      });
    } catch {
      continue;
    }
  }
  out.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  return out;
}
