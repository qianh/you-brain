import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { YouBrainError } from "../domain/errors.js";
import { portraitFile, type YouBrainPaths } from "../domain/paths.js";
import type { PortraitResponse, PortraitSnapshot } from "./types.js";

const pathsFor = (portraitDir: string): YouBrainPaths =>
  ({ portraitDir }) as YouBrainPaths;

export function assertPortraitVariant(variant: string): void {
  try {
    portraitFile(pathsFor("."), variant);
  } catch {
    throw new YouBrainError("INVALID_INPUT", "无效的数字分身变体");
  }
}

export async function readPortraitFile(
  portraitDir: string,
  variant: string,
): Promise<PortraitResponse | null> {
  assertPortraitVariant(variant);
  const path = portraitFile(pathsFor(portraitDir), variant);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  const info = await stat(path);
  return {
    variant,
    content,
    path,
    updatedAt: info.mtime.toISOString(),
  };
}

export async function listPortraitSnapshots(
  portraitDir: string,
  pattern = "*v*-*.md",
): Promise<PortraitSnapshot[]> {
  let names: string[];
  try {
    names = await readdir(portraitDir);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const glob = pattern.includes("/")
    ? pattern.slice(pattern.lastIndexOf("/") + 1)
    : pattern;
  const match = globToRegExp(glob);
  const snapshots: PortraitSnapshot[] = [];
  for (const name of names) {
    if (!match.test(name)) continue;
    const path = join(portraitDir, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    snapshots.push({
      name,
      path,
      updatedAt: info.mtime.toISOString(),
    });
  }
  snapshots.sort((left, right) => compareText(left.name, right.name));
  return snapshots;
}

function globToRegExp(glob: string): RegExp {
  let source = "^";
  for (const char of glob) {
    if (char === "*") source += "[^/]*";
    else if ("\\^$+?.()|{}[]".includes(char)) source += `\\${char}`;
    else source += char;
  }
  return new RegExp(`${source}$`, "u");
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
