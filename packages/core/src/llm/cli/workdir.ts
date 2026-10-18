import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { platformPaths } from "../../domain/paths.js";

/** Dedicated cwd for subscription CLIs. Sessions written here must not be captured. */
export function llmCliWorkDir(dataDir?: string): string {
  const root =
    dataDir !== undefined && dataDir.trim() !== ""
      ? resolve(dataDir)
      : platformPaths({
          platform: process.platform as "darwin" | "linux",
          homeDir: homedir(),
          env: process.env,
        }).dataDir;
  return join(root, "llm-cli");
}

/** Logical path plus the physical path (macOS /tmp → /private/tmp). */
export function physicalCandidates(dir: string): string[] {
  const resolved = resolve(dir);
  const found = new Set<string>([resolved]);
  const addReal = (path: string): void => {
    try {
      found.add(realpathSync(path));
      return;
    } catch {
      const missing: string[] = [];
      let current = path;
      while (current !== dirname(current)) {
        const parent = dirname(current);
        missing.unshift(basename(current));
        try {
          found.add(join(realpathSync(parent), ...missing));
          return;
        } catch {
          current = parent;
        }
      }
    }
  };
  addReal(resolved);
  return [...found];
}

export function physicalPath(dir: string): string {
  const candidates = physicalCandidates(dir);
  return candidates[candidates.length - 1] ?? resolve(dir);
}

export async function ensureCliWorkDir(dataDir?: string): Promise<string> {
  const logical = llmCliWorkDir(dataDir);
  await mkdir(logical, { recursive: true });
  return physicalPath(logical);
}

function normalizeDir(dir: string): string {
  const resolved = resolve(dir);
  if (resolved === "/") return "/";
  return resolved.replace(/\/+$/u, "");
}

/** Claude Code project directory: every non-alphanumeric character becomes '-'. */
export function claudeProjectKey(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/gu, "-");
}

/** Gemini CLI project temp dir is sha256(path.resolve(cwd)). */
export function geminiProjectHash(dir: string): string {
  return createHash("sha256").update(dir).digest("hex");
}

export function isDedicatedCapturePath(
  sessionPath: string,
  workDir: string,
  encode: (dir: string) => string,
): boolean {
  const markers = new Set(physicalCandidates(workDir).map(encode));
  return sessionPath.split(/[/\\]/u).some((segment) => markers.has(segment));
}

export function isDedicatedCwd(cwd: string | null | undefined, workDir: string): boolean {
  if (cwd === null || cwd === undefined || cwd.trim() === "") return false;
  const wanted = new Set(physicalCandidates(workDir).map(normalizeDir));
  return physicalCandidates(cwd).some((candidate) => wanted.has(normalizeDir(candidate)));
}
