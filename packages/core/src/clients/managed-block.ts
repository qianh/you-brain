import { readFile, rm, writeFile } from "node:fs/promises";

import { writeFileAtomic } from "../domain/atomic.js";
import { YouBrainError } from "../domain/errors.js";

export const MANAGED_BLOCK_VERSION = "v1";

const BLOCK_PATTERN =
  /[ \t]*<!-- you-brain:start v\d+ -->[\s\S]*?<!-- you-brain:end -->[ \t]*/u;

export function managedBlock(body: string, version = MANAGED_BLOCK_VERSION): string {
  if (!/^v\d+$/u.test(version)) {
    throw new YouBrainError("INVALID_INPUT", "Managed block version must look like v1");
  }
  const text = body.trim();
  if (text.includes("<!-- you-brain:")) {
    throw new YouBrainError("INVALID_INPUT", "Managed block body cannot contain markers");
  }
  return `<!-- you-brain:start ${version} -->\n${text}\n<!-- you-brain:end -->`;
}

export function upsertManagedBlockText(
  existing: string,
  body: string,
  version = MANAGED_BLOCK_VERSION,
): string {
  const block = managedBlock(body, version);
  if (BLOCK_PATTERN.test(existing)) {
    const replaced = existing.replace(BLOCK_PATTERN, block);
    return replaced.endsWith("\n") ? replaced : `${replaced}\n`;
  }
  if (existing.trim() === "") return `${block}\n`;
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${block}\n`;
}

export function removeManagedBlockText(existing: string): string {
  if (!BLOCK_PATTERN.test(existing)) return existing;
  const removed = existing.replace(BLOCK_PATTERN, "");
  const collapsed = removed.replace(/\n{3,}/gu, "\n\n");
  if (collapsed.trim() === "") return "";
  return collapsed.endsWith("\n") ? collapsed : `${collapsed}\n`;
}

export function hasManagedBlock(existing: string): boolean {
  return BLOCK_PATTERN.test(existing);
}

interface ManagedLedger {
  version: 1;
  files: Record<string, { originallyAbsent: boolean }>;
}

function emptyLedger(): ManagedLedger {
  return { version: 1, files: {} };
}

async function readLedger(path: string): Promise<ManagedLedger> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ManagedLedger>;
    if (!parsed || parsed.version !== 1 || !parsed.files || typeof parsed.files !== "object") {
      return emptyLedger();
    }
    return { version: 1, files: parsed.files };
  } catch (error) {
    if (isEnoent(error)) return emptyLedger();
    throw error;
  }
}

async function writeLedger(path: string, ledger: ManagedLedger): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(ledger, null, 2)}\n`);
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export interface ManagedBlockWriteResult {
  path: string;
  changed: boolean;
  created: boolean;
  content: string;
}

export async function upsertManagedBlock(options: {
  path: string;
  body: string;
  version?: string;
  statePath: string;
}): Promise<ManagedBlockWriteResult> {
  const current = await readOptional(options.path);
  const ledger = await readLedger(options.statePath);
  const record = ledger.files[options.path];
  if (!record) {
    ledger.files[options.path] = { originallyAbsent: current === null };
    await writeLedger(options.statePath, ledger);
  }
  const next = upsertManagedBlockText(
    current ?? "",
    options.body,
    options.version ?? MANAGED_BLOCK_VERSION,
  );
  if (current === next) {
    return { path: options.path, changed: false, created: false, content: next };
  }
  await writeFileAtomic(options.path, next, { mode: 0o644 });
  return {
    path: options.path,
    changed: true,
    created: current === null,
    content: next,
  };
}

export async function removeManagedBlock(options: {
  path: string;
  statePath: string;
}): Promise<{ removed: boolean; deletedFile: boolean; content: string }> {
  const current = await readOptional(options.path);
  if (current === null) return { removed: false, deletedFile: false, content: "" };
  if (!hasManagedBlock(current)) {
    return { removed: false, deletedFile: false, content: current };
  }
  const next = removeManagedBlockText(current);
  const ledger = await readLedger(options.statePath);
  const originallyAbsent = ledger.files[options.path]?.originallyAbsent === true;
  if (next.trim() === "" && originallyAbsent) {
    await rm(options.path, { force: true });
    delete ledger.files[options.path];
    await writeLedger(options.statePath, ledger);
    return { removed: true, deletedFile: true, content: "" };
  }
  if (next !== current) {
    await writeFile(options.path, next);
  }
  return { removed: true, deletedFile: false, content: next };
}
