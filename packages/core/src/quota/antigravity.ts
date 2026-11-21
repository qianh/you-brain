import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCliProcess } from "../llm/cli/exec.js";
import { isExecutable } from "../llm/cli/locate.js";
import type { QuotaAccount, QuotaWindow } from "./types.js";

/** magpie has no Antigravity numbers, so its CLI is asked directly; it answers in a few seconds. */
export const ANTIGRAVITY_TIMEOUT_MS = 30_000;

export const ANTIGRAVITY_BIN_ENV = "YOU_BRAIN_AGY_BIN";

/** `YOU_BRAIN_AGY_BIN` wins (and, if not runnable, means "no agy"); then PATH; then the usual spots. */
export function locateAntigravity(input: { env: NodeJS.ProcessEnv; homeDir: string }): string | null {
  const configured = input.env[ANTIGRAVITY_BIN_ENV]?.trim();
  if (configured) return isExecutable(configured) ? configured : null;
  const candidates = [
    ...(input.env.PATH ?? "").split(":").filter((dir) => dir.trim() !== "").map((dir) => join(dir, "agy")),
    join(input.homeDir, ".local", "bin", "agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ];
  return candidates.find(isExecutable) ?? null;
}

/** Runs `agy -p /quota`: a slash command, so it prints the table without calling a model. */
export async function readAntigravityQuota(input: {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  signal?: AbortSignal;
}): Promise<string> {
  const bin = locateAntigravity(input);
  if (bin === null) throw new Error("没有找到 agy");
  const result = await runCliProcess({
    bin,
    args: ["-p", "/quota"],
    cwd: tmpdir(),
    timeoutMs: ANTIGRAVITY_TIMEOUT_MS,
    env: input.env,
    secrets: [],
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (result.exitCode !== 0) throw new Error(`agy 退出码 ${result.exitCode}`);
  return result.stdout;
}

/** "Gemini Models" → "Gemini", "Claude and GPT models" → "Claude+GPT": the top bar has little room. */
function groupName(group: string): string {
  return group.replace(/\s+models$/iu, "").replace(/\s+and\s+/iu, "+").trim();
}

/**
 * Parses the `/quota` table: one tab-separated line per limit, "group, limit name,
 * remaining percent, reset time". The epoch reset time means "not started" and becomes null.
 * Null when no line is usable, so a changed format never shows made-up numbers.
 */
export function parseAntigravityQuota(stdout: string): QuotaWindow[] | null {
  const windows: QuotaWindow[] = [];
  for (const line of stdout.split("\n")) {
    const [group, label, remaining, reset] = line.split("\t").map((part) => part.trim());
    if (!group || !label || !remaining) continue;
    const percent = /^(\d+(?:\.\d+)?)%$/u.exec(remaining)?.[1];
    if (percent === undefined) continue;
    const span = /five\s*hour/iu.test(label) ? "5 hours" : /weekly/iu.test(label) ? "7 days" : null;
    if (span === null) continue;
    const resetMs = reset ? Date.parse(reset) : Number.NaN;
    windows.push({
      name: `${span} · ${groupName(group)}`,
      used: Math.min(100, Math.max(0, 100 - Number(percent))),
      resetsAt: Number.isNaN(resetMs) || resetMs <= 0 ? null : new Date(resetMs).toISOString(),
    });
  }
  return windows.length > 0 ? windows : null;
}

export function antigravityAccount(windows: QuotaWindow[], readAtMs: number, nowMs: number): QuotaAccount {
  return {
    id: createHash("sha256").update("antigravity").digest("hex").slice(0, 12),
    agent: "antigravity",
    plan: null,
    active: true,
    windows,
    readAt: new Date(Math.min(readAtMs, nowMs)).toISOString(),
    stale: false,
  };
}
