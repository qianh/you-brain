import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import { ConsolidateLeaseSchema } from "@you-brain/core/consolidate";
import {
  parseDeviceRecord,
  parseEventsJsonl,
  parseRoles,
  parseSessionFrontmatter,
} from "@you-brain/protocol";
import type { Command } from "commander";

import { fail } from "./env.js";

const KINDS = ["device", "events", "roles", "lease", "session"] as const;

type ValidateKind = (typeof KINDS)[number];

export function registerProtocolCommand(program: Command): void {
  const protocol = program.command("protocol").description("校验本地协议文件，不访问 Drive");
  protocol
    .command("validate")
    .description("校验设备记录、事件、角色、租约或会话文件")
    .argument("<file>", "本地文件")
    .option("--kind <kind>", "device、events、roles、lease 或 session")
    .action(async (file: string, opts: { kind?: string }) => {
      try {
        const code = await validateProtocolFile(file, opts.kind);
        if (code !== 0) process.exit(code);
      } catch (error) {
        fail(error);
      }
    });
}

export async function validateProtocolFile(
  file: string,
  kindText: string | undefined,
): Promise<number> {
  const kind = resolveKind(file, kindText);
  if (kind === null) {
    console.error("--kind 只能是 device、events、roles、lease 或 session");
    return 1;
  }
  if (!existsSync(file)) {
    console.error(`${file}: 文件不存在`);
    return 1;
  }
  const text = await readFile(file, "utf8");
  if (kind === "events") return reportEvents(file, text);
  if (kind === "session") return reportSession(file, text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    console.error(`${file}: JSON: ${oneLine(message)}`);
    return 1;
  }
  try {
    if (kind === "device") parseDeviceRecord(parsed);
    else if (kind === "roles") parseRoles(parsed);
    else ConsolidateLeaseSchema.parse(parsed);
    return 0;
  } catch (error) {
    const issues = zodIssues(error);
    if (issues.length === 0) {
      console.error(`${file}: ${oneLine(error instanceof Error ? error.message : String(error))}`);
      return 1;
    }
    for (const issue of issues) {
      console.error(`${file}: ${issue.path}: ${oneLine(issue.message)}`);
    }
    return 1;
  }
}

function resolveKind(file: string, kindText: string | undefined): ValidateKind | null {
  if (kindText === undefined) return guessKind(file);
  return (KINDS as readonly string[]).includes(kindText) ? (kindText as ValidateKind) : null;
}

function guessKind(file: string): ValidateKind {
  const ext = extname(file).toLowerCase();
  if (ext === ".jsonl") return "events";
  if (ext === ".md") return "session";
  return "device";
}

function reportEvents(file: string, text: string): number {
  const parsed = parseEventsJsonl(text);
  if (parsed.errors.length === 0) return 0;
  for (const error of parsed.errors) {
    console.error(`${file}:${error.line}: ${oneLine(error.message)}`);
  }
  return 1;
}

function reportSession(file: string, text: string): number {
  const parsed = parseSessionFrontmatter(text);
  if (parsed.ok) return 0;
  for (const error of parsed.errors) {
    const where = error.line === undefined ? file : `${file}:${error.line}`;
    console.error(`${where}: ${error.path}: ${oneLine(error.message)}`);
  }
  return 1;
}

function zodIssues(error: unknown): Array<{ path: string; message: string }> {
  if (typeof error !== "object" || error === null || !("issues" in error)) return [];
  const issues = error.issues;
  if (!Array.isArray(issues)) return [];
  const rows: Array<{ path: string; message: string }> = [];
  for (const issue of issues) {
    if (typeof issue !== "object" || issue === null || !("message" in issue)) continue;
    if (typeof issue.message !== "string") continue;
    const path =
      "path" in issue && Array.isArray(issue.path) ? issue.path.map(String).join(".") : "";
    rows.push({ path: path === "" ? "(root)" : path, message: issue.message });
  }
  return rows;
}

function oneLine(message: string): string {
  return message.replace(/\s+/gu, " ").trim();
}
