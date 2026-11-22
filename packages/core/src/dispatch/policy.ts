import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";

import { MODE_ORDER, type RuntimeModeName } from "@you-brain/protocol";

import { writeFileAtomic } from "../domain/atomic.js";

/** 本机是否接受派活，以及谁可以派到哪些项目、权限上限。 */
export interface DispatchSender {
  deviceId: string;
  name: string;
  publicKey: string;
}

export interface DispatchPolicy {
  enabled: boolean;
  notify: boolean;
  maxMode: RuntimeModeName;
  allowedSenders: DispatchSender[];
  allowedProjects: string[];
}

export function defaultDispatchPolicy(): DispatchPolicy {
  return { enabled: false, notify: true, maxMode: "auto", allowedSenders: [], allowedProjects: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuntimeMode(value: unknown): value is RuntimeModeName {
  return typeof value === "string" && (MODE_ORDER as readonly string[]).includes(value);
}

function dedupeSenders(value: unknown): DispatchSender[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, DispatchSender>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.deviceId !== "string" || item.deviceId === "") continue;
    if (typeof item.name !== "string" || typeof item.publicKey !== "string" || item.publicKey === "") continue;
    byId.set(item.deviceId, { deviceId: item.deviceId, name: item.name, publicKey: item.publicKey });
  }
  return [...byId.values()];
}

function dedupeProjects(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const projects: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item === "" || seen.has(item)) continue;
    seen.add(item);
    projects.push(item);
  }
  return projects;
}

/** 缺文件、读不出或 JSON 损坏时整份回落默认；只是 maxMode 非法则单独回落 auto。 */
export function normalizeDispatchPolicy(value: unknown): DispatchPolicy {
  if (!isRecord(value)) return defaultDispatchPolicy();
  return {
    enabled: value.enabled === true,
    notify: value.notify !== false,
    maxMode: isRuntimeMode(value.maxMode) ? value.maxMode : "auto",
    allowedSenders: dedupeSenders(value.allowedSenders),
    allowedProjects: dedupeProjects(value.allowedProjects),
  };
}

/** `<dataDir>/dispatch/policy.json`，0600，临时文件 + rename。 */
export class PolicyStore {
  readonly #file: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.#file = join(dataDir, "dispatch", "policy.json");
  }

  file(): string {
    return this.#file;
  }

  read(): Promise<DispatchPolicy> {
    return this.#enqueue(() => this.#read());
  }

  write(patch: Partial<DispatchPolicy>): Promise<DispatchPolicy> {
    return this.#enqueue(async () => {
      const current = await this.#read();
      const next = normalizeDispatchPolicy({
        enabled: patch.enabled ?? current.enabled,
        notify: patch.notify ?? current.notify,
        maxMode: patch.maxMode !== undefined ? patch.maxMode : current.maxMode,
        allowedSenders: patch.allowedSenders ?? current.allowedSenders,
        allowedProjects: patch.allowedProjects ?? current.allowedProjects,
      });
      await writeFileAtomic(this.#file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await chmod(this.#file, 0o600);
      return next;
    });
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #read(): Promise<DispatchPolicy> {
    try {
      return normalizeDispatchPolicy(JSON.parse(await readFile(this.#file, "utf8")));
    } catch {
      return defaultDispatchPolicy();
    }
  }
}
