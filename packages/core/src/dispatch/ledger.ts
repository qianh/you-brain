import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { LaunchModeName } from "@you-brain/protocol";

import { writeFileAtomic } from "../domain/atomic.js";

/** 一次派活创建的会话。threadUrl / mode / capped 用来在相同 dispatchId 再次到来时返回同一结果。 */
export interface DispatchRecord {
  threadId: string;
  from: string;
  projectId: string;
  title: string;
  createdAt: number;
  threadUrl: string;
  mode: LaunchModeName;
  capped: boolean;
}

export interface DispatchHit extends DispatchRecord {
  dispatchId: string;
}

export type CommandOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export interface CommandRecord {
  result: CommandOutcome;
  at: number;
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLaunchMode(value: unknown): value is LaunchModeName {
  return value === "auto-accept-edits" || value === "auto" || value === "full-access";
}

function isDispatch(value: unknown): value is DispatchRecord {
  return isRecord(value) && typeof value.threadId === "string" && typeof value.from === "string" &&
    typeof value.projectId === "string" && typeof value.title === "string" && typeof value.createdAt === "number" &&
    typeof value.threadUrl === "string" && isLaunchMode(value.mode) && typeof value.capped === "boolean";
}

function isOutcome(value: unknown): value is CommandOutcome {
  return isRecord(value) && (value.ok === true || (value.ok === false && typeof value.error === "string"));
}

function isCommand(value: unknown): value is CommandRecord {
  return isRecord(value) && typeof value.at === "number" && isOutcome(value.result);
}

interface LedgerFile {
  dispatches: Map<string, DispatchRecord>;
  commands: Map<string, CommandRecord>;
}

function emptyFile(): LedgerFile {
  return { dispatches: new Map(), commands: new Map() };
}

function prune(file: LedgerFile, now: number): void {
  dropExpired(file.dispatches, now, (entry) => entry.createdAt);
  dropExpired(file.commands, now, (entry) => entry.at);
  cap(file.dispatches, (entry) => entry.createdAt);
  cap(file.commands, (entry) => entry.at);
}

function dropExpired<T>(table: Map<string, T>, now: number, at: (entry: T) => number): void {
  for (const [key, entry] of table) {
    if (now - at(entry) > RETENTION_MS) table.delete(key);
  }
}

function cap<T>(table: Map<string, T>, at: (entry: T) => number): void {
  if (table.size <= MAX_ENTRIES) return;
  const oldest = [...table.entries()].sort((left, right) => at(left[1]) - at(right[1]));
  for (const [key] of oldest.slice(0, oldest.length - MAX_ENTRIES)) table.delete(key);
}

/** `<dataDir>/dispatch/ledger.json`。写入时丢掉超过 7 天或各自超出 1000 条的记录。 */
export class Ledger {
  readonly #file: string;
  readonly #now: () => number;
  #queue: Promise<unknown> = Promise.resolve();
  #data: LedgerFile | null = null;

  constructor(dataDir: string, now: () => number = Date.now) {
    this.#file = join(dataDir, "dispatch", "ledger.json");
    this.#now = now;
  }

  getDispatch(dispatchId: string): Promise<DispatchRecord | null> {
    return this.#enqueue(async () => {
      const file = await this.#load();
      const found = file.dispatches.get(dispatchId);
      return found ? { ...found } : null;
    });
  }

  putDispatch(dispatchId: string, record: DispatchRecord): Promise<void> {
    return this.#enqueue(async () => {
      const file = await this.#load();
      file.dispatches.set(dispatchId, { ...record });
      prune(file, this.#now());
      await this.#save(file);
    });
  }

  getCommand(cmdId: string): Promise<CommandRecord | null> {
    return this.#enqueue(async () => {
      const file = await this.#load();
      const found = file.commands.get(cmdId);
      return found ? { result: structuredClone(found.result), at: found.at } : null;
    });
  }

  putCommand(cmdId: string, result: CommandOutcome): Promise<void> {
    return this.#enqueue(async () => {
      const file = await this.#load();
      file.commands.set(cmdId, { result: structuredClone(result), at: this.#now() });
      prune(file, this.#now());
      await this.#save(file);
    });
  }

  threadIds(): Promise<string[]> {
    return this.#enqueue(async () => {
      const file = await this.#load();
      return [...new Set([...file.dispatches.values()].map((entry) => entry.threadId))];
    });
  }

  findByThread(threadId: string): Promise<DispatchHit | null> {
    return this.#enqueue(async () => {
      const file = await this.#load();
      for (const [dispatchId, entry] of file.dispatches) {
        if (entry.threadId === threadId) return { dispatchId, ...entry };
      }
      return null;
    });
  }

  listDispatches(): Promise<DispatchHit[]> {
    return this.#enqueue(async () => {
      const file = await this.#load();
      return [...file.dispatches.entries()].map(([dispatchId, entry]) => ({ dispatchId, ...entry }));
    });
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #load(): Promise<LedgerFile> {
    if (this.#data) return this.#data;
    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#data = emptyFile();
        return this.#data;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.#data = emptyFile();
      return this.#data;
    }
    const file = emptyFile();
    if (isRecord(parsed)) {
      if (isRecord(parsed.dispatches)) {
        for (const [id, entry] of Object.entries(parsed.dispatches)) {
          if (isDispatch(entry)) file.dispatches.set(id, entry);
        }
      }
      if (isRecord(parsed.commands)) {
        for (const [id, entry] of Object.entries(parsed.commands)) {
          if (isCommand(entry)) file.commands.set(id, entry);
        }
      }
    }
    this.#data = file;
    return file;
  }

  async #save(file: LedgerFile): Promise<void> {
    const body = {
      dispatches: Object.fromEntries(file.dispatches),
      commands: Object.fromEntries(file.commands),
    };
    await writeFileAtomic(this.#file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    await chmod(this.#file, 0o600);
  }
}
