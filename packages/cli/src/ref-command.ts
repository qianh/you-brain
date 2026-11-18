import {
  parseReferenceUri,
  REFERENCE_KINDS,
  type ReferenceKind,
} from "@you-brain/core";
import type { ReferenceCandidateView } from "@you-brain/core/http";
import type { Command } from "commander";

import { CliError, connectDaemon, fail } from "./env.js";

const KIND_LABELS: Record<ReferenceKind, string> = {
  tty7: "终端会话",
  session: "会话",
  topic: "话题",
  kb: "知识库",
};

interface SearchOptions {
  kind?: string;
  limit?: string;
  json?: boolean;
}

interface GetOptions {
  kind?: string;
  materialize?: boolean;
  pathOnly?: boolean;
  json?: boolean;
}

function parseKind(raw: string | undefined): ReferenceKind | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim() as ReferenceKind;
  if (!REFERENCE_KINDS.includes(trimmed)) {
    throw new CliError(`--kind 只能是 ${REFERENCE_KINDS.join("、")}`);
  }
  return trimmed;
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new CliError("--limit 必须是 1 到 50 的整数");
  }
  return parsed;
}

function printCandidates(candidates: readonly ReferenceCandidateView[]): void {
  if (candidates.length === 0) {
    console.log("没有找到可引用的内容。");
    return;
  }
  for (const kind of REFERENCE_KINDS) {
    const group = candidates.filter((item) => item.kind === kind);
    if (group.length === 0) continue;
    console.log(`[${KIND_LABELS[kind]}]`);
    for (const item of group) {
      console.log(`- ${item.label}  ${item.uri}`);
      if (item.detail) console.log(`  ${item.detail}`);
    }
  }
}

async function runSearch(query: string | undefined, opts: SearchOptions): Promise<void> {
  const kind = parseKind(opts.kind);
  const limit = parseLimit(opts.limit);
  const client = await connectDaemon();
  const res = await client.referenceCandidates({
    ...(query !== undefined && query.trim() !== "" ? { query: query.trim() } : {}),
    ...(kind !== undefined ? { kinds: [kind] } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  printCandidates(res.candidates);
}

function isDirectReferenceTarget(target: string): boolean {
  const trimmed = target.trim();
  if (parseReferenceUri(trimmed) !== null) return true;
  return /^(?:(?:tty7|终端)[:：])?%?\d+$/iu.test(trimmed);
}

async function runGet(target: string, opts: GetOptions): Promise<void> {
  const kind = parseKind(opts.kind);
  const trimmed = target.trim();
  if (trimmed === "") throw new CliError("请提供引用关键词或 URI");
  const request = isDirectReferenceTarget(trimmed)
    ? { uri: trimmed }
    : { query: trimmed, ...(kind !== undefined ? { kind } : {}) };
  const client = await connectDaemon();
  if (opts.materialize || opts.pathOnly) {
    const res = await client.materializeReference(request);
    if (opts.pathOnly) {
      console.log(res.fileMention);
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(res.fileMention);
    console.log("");
    console.log(res.wrappedText);
    return;
  }
  const res = await client.referenceContent(request);
  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(res.wrappedText);
}

export function registerRefCommand(program: Command): void {
  const ref = program
    .command("ref")
    .description("检索、读取并物化可 @ 引用的 U-Brain 会话、话题、知识库与终端会话")
    .argument("[query]", "搜索关键词（省略则列出最近项）")
    .option("--kind <kind>", "限定类型：tty7、session、topic 或 kb")
    .option("--limit <n>", "每类最多返回条数（1-50）")
    .option("--json", "输出 JSON")
    .action(async (query: string | undefined, opts: SearchOptions) => {
      try {
        await runSearch(query, opts);
      } catch (error) {
        fail(error);
      }
    });

  ref
    .command("search")
    .description("列出可 @ 引用的候选内容")
    .argument("[query]", "搜索关键词")
    .option("--kind <kind>", "限定类型：tty7、session、topic 或 kb")
    .option("--limit <n>", "每类最多返回条数（1-50）")
    .option("--json", "输出 JSON")
    .action(async (query: string | undefined, opts: SearchOptions) => {
      try {
        await runSearch(query, opts);
      } catch (error) {
        fail(error);
      }
    });

  ref
    .command("get")
    .description("读取指定引用正文，或落盘生成 @/path/to/file.md")
    .argument("<target>", "引用关键词（如 @知识库:合同）、u-brain-... URI 或 %pane")
    .option("--kind <kind>", "限定类型：tty7、session、topic 或 kb")
    .option("--materialize", "落盘到 ~/.you-brain/references/ 并显示文件路径")
    .option("--path-only", "落盘后只打印 @/abs/path/...md")
    .option("--json", "输出 JSON")
    .action(async (target: string, opts: GetOptions) => {
      try {
        await runGet(target, opts);
      } catch (error) {
        fail(error);
      }
    });
}
