import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import * as zlib from "node:zlib";

import type { NormalizedSession } from "../domain/session.js";
import type { AdapterResult, CaptureOptions, SourceAdapter, SourceFile } from "./types.js";

/**
 * DeepSeek Harness（指挥台的运行时）的会话：
 * `<dsh home>/sessions/<工作区>/session-<id>/session.v4.jsonl.zstd`，zstd 压缩的 JSONL 事件流。
 * 第一行是 `{"type":"session",id,createdAt,cwd,delegationDepth}`，之后是 `{type,seq,time,data}`。
 *
 * 只取真实的对话：`user/message` 里 `source.kind === "user"` 的（DSH 还会注入
 * `runtime-context`、`skill-catalog` 等同样是 user 消息的上下文，那不是用户说的话），以及
 * `assistant/message` 里 `type:"text"` 的块。工具调用、思考块不进入会话原文。
 * 事件格式依据 DSH 持久化 schema 和 SDK client 取最终回复的方式，并用真实会话文件核对过。
 */

const SESSION_FILE = "session.v4.jsonl.zstd";

/** DSH 的 home 在指挥台的数据目录下（见 deck/dsh/runtime.ts）。 */
export function dshSessionsRoot(dataDir: string): string {
  return join(dataDir, "deck", "dsh", "home", "sessions");
}

type Zstd = (input: Uint8Array) => Uint8Array;

/** Bun（daemon 与测试）自带 zstd；Node ≥ 22.15 的 zlib 也有。 */
function zstdDecompress(): Zstd | null {
  const bun = (globalThis as { Bun?: { zstdDecompressSync?: Zstd } }).Bun;
  if (bun?.zstdDecompressSync) return bun.zstdDecompressSync.bind(bun);
  const node = (zlib as unknown as { zstdDecompressSync?: Zstd }).zstdDecompressSync;
  return node ?? null;
}

interface DshEvent {
  type?: unknown;
  time?: unknown;
  data?: unknown;
  createdAt?: unknown;
  cwd?: unknown;
  delegationDepth?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

function finiteMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** 解析单个会话文件。读不了/还在写（zstd 帧不完整）返回 malformed，稍后重扫会再试。 */
export async function parseDshSession(path: string, options: CaptureOptions): Promise<AdapterResult> {
  const decompress = zstdDecompress();
  if (decompress === null) return { session: null, skippedSubagent: false, malformedLines: 1 };
  let events: DshEvent[];
  try {
    const raw = new Uint8Array(await readFile(path));
    const text = new TextDecoder().decode(decompress(raw));
    events = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        events.push(JSON.parse(line) as DshEvent);
      } catch {
        // 坏行跳过。
      }
    }
  } catch {
    return { session: null, skippedSubagent: false, malformedLines: 1 };
  }
  const header = events.find((event) => event.type === "session");
  const depth = typeof header?.delegationDepth === "number" ? header.delegationDepth : 0;
  if (depth > 0 && !options.includeSubagents) {
    return { session: null, skippedSubagent: true, malformedLines: 0 };
  }

  const turns: NormalizedSession["turns"] = [];
  const stamps: number[] = [];
  const created = finiteMs(header?.createdAt);
  if (created !== null) stamps.push(created);
  for (const event of events) {
    const data = isRecord(event.data) ? event.data : null;
    if (data === null) continue;
    const at = finiteMs(event.time);
    if (event.type === "user/message") {
      const source = isRecord(data.source) ? data.source : null;
      if (source?.kind !== "user") continue;
      const text = textOf(data.content);
      if (text === "") continue;
      turns.push({ role: "user", text, images: [] });
      if (at !== null) stamps.push(at);
    } else if (event.type === "assistant/message") {
      const message = isRecord(data.message) ? data.message : null;
      const text = textOf(message?.content);
      if (text === "") continue;
      const last = turns[turns.length - 1];
      // 一个回合里模型可能分几步说话（中间夹工具调用），合并成一条回复。
      if (last?.role === "assistant") last.text = `${last.text}\n\n${text}`;
      else turns.push({ role: "assistant", text, images: [] });
      if (at !== null) stamps.push(at);
    }
  }
  if (turns.length === 0) return { session: null, skippedSubagent: false, malformedLines: 0 };

  let statMs = 0;
  try {
    statMs = (await stat(path)).mtimeMs;
  } catch {
    statMs = 0;
  }
  const startMs = stamps.length > 0 ? Math.min(...stamps) : statMs;
  const endMs = stamps.length > 0 ? Math.max(...stamps) : statMs;
  if (startMs <= 0) return { session: null, skippedSubagent: false, malformedLines: 0 };
  const session: NormalizedSession = {
    source: "dsh",
    conversationId: basename(dirname(path)),
    device: options.device,
    startedAt: new Date(startMs).toISOString(),
    updatedAt: new Date(Math.max(endMs, startMs)).toISOString(),
    turns,
    sourcePath: path,
    warnings: [],
  };
  return { session, skippedSubagent: false, malformedLines: 0 };
}

export const dshAdapter: SourceAdapter = {
  id: "dsh",
  /** 默认根目录依赖数据目录，不在用户 home 下；由 daemon 的 #roots() 给出。 */
  defaultRoots(): string[] {
    return [];
  },
  async *discover(roots: string[]): AsyncIterable<SourceFile> {
    for (const root of roots) {
      let workspaces: string[];
      try {
        workspaces = await readdir(root);
      } catch {
        continue;
      }
      for (const workspace of workspaces) {
        let sessions: string[];
        try {
          sessions = await readdir(join(root, workspace));
        } catch {
          continue;
        }
        for (const name of sessions) {
          if (!name.startsWith("session-")) continue;
          const path = join(root, workspace, name, SESSION_FILE);
          try {
            await stat(path);
          } catch {
            continue;
          }
          yield { path, source: dshAdapter.id };
        }
      }
    }
  },
  parse(file: SourceFile, opts: CaptureOptions): Promise<NormalizedSession[]> {
    return parseDshSession(file.path, opts).then((result) => (result.session === null ? [] : [result.session]));
  },
};
