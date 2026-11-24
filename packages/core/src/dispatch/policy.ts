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

export interface MasterModelOption {
  id: string;
  value: unknown;
}

export interface MasterModelSelection {
  instanceId: string;
  model: string;
  options?: MasterModelOption[];
}

export interface DispatchPolicy {
  enabled: boolean;
  /** 允许「允许的发起设备」在它们的指挥台里查看并操作本机 T3（经加密隧道）。与 enabled（接收派活）各自独立。 */
  viewT3: boolean;
  /** 允许「允许的发起设备」通过 WebRTC 查看并操作本机图形桌面。与 enabled、viewT3 各自独立。 */
  remoteDesktop: boolean;
  /** 信任所有入网设备：云盘 you-brain/relay/members 里登记的设备都算允许的发起设备（公钥取自云盘）。 */
  trustEnrolled: boolean;
  /** 全部项目可派（含以后新加的），不看 allowedProjects。 */
  allProjects: boolean;
  /** 入网后已按「互相信任」自动配置过一次；之后用户手动改的设置不再被覆盖。 */
  autoConfigured: boolean;
  notify: boolean;
  maxMode: RuntimeModeName;
  allowedSenders: DispatchSender[];
  allowedProjects: string[];
  /** 手机端主控会话默认使用的 T3 项目 ID（优先于自动挑选）。 */
  masterProjectId?: string;
  /** 手机端主控会话默认使用的模型与选项（显式配置时优先于项目默认模型）。 */
  masterModelSelection?: MasterModelSelection;
}

export function defaultDispatchPolicy(): DispatchPolicy {
  return {
    enabled: false,
    viewT3: false,
    remoteDesktop: false,
    trustEnrolled: false,
    allProjects: false,
    autoConfigured: false,
    notify: true,
    maxMode: "auto",
    allowedSenders: [],
    allowedProjects: [],
  };
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

function normalizeMasterProjectId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function normalizeMasterModelOptions(value: unknown): MasterModelOption[] | undefined {
  const raw: Array<{ id: string; value: unknown }> = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item) || typeof item.id !== "string" || item.id.trim() === "" || item.value === undefined) continue;
      raw.push({ id: item.id.trim(), value: item.value });
    }
  } else if (isRecord(value)) {
    for (const [id, optionValue] of Object.entries(value)) {
      if (id.trim() === "" || optionValue === undefined) continue;
      raw.push({ id: id.trim(), value: optionValue });
    }
  }
  if (raw.length === 0) return undefined;
  const deduped = new Map<string, MasterModelOption>();
  for (const option of raw) deduped.set(option.id, option);
  return [...deduped.values()];
}

function normalizeMasterModelSelection(value: unknown): MasterModelSelection | undefined {
  if (!isRecord(value)) return undefined;
  const instanceId = typeof value.instanceId === "string" ? value.instanceId.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (instanceId === "" || model === "") return undefined;
  const options = normalizeMasterModelOptions(value.options);
  return options ? { instanceId, model, options } : { instanceId, model };
}

/** 缺文件、读不出或 JSON 损坏时整份回落默认；只是 maxMode 非法则单独回落 auto。 */
export function normalizeDispatchPolicy(value: unknown): DispatchPolicy {
  if (!isRecord(value)) return defaultDispatchPolicy();
  const masterProjectId = normalizeMasterProjectId(value.masterProjectId);
  const masterModelSelection = normalizeMasterModelSelection(value.masterModelSelection);
  return {
    enabled: value.enabled === true,
    viewT3: value.viewT3 === true,
    remoteDesktop: value.remoteDesktop === true,
    trustEnrolled: value.trustEnrolled === true,
    allProjects: value.allProjects === true,
    autoConfigured: value.autoConfigured === true,
    notify: value.notify !== false,
    maxMode: isRuntimeMode(value.maxMode) ? value.maxMode : "auto",
    allowedSenders: dedupeSenders(value.allowedSenders),
    allowedProjects: dedupeProjects(value.allowedProjects),
    ...(masterProjectId !== undefined ? { masterProjectId } : {}),
    ...(masterModelSelection !== undefined ? { masterModelSelection } : {}),
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
        viewT3: patch.viewT3 ?? current.viewT3,
        remoteDesktop: patch.remoteDesktop ?? current.remoteDesktop,
        trustEnrolled: patch.trustEnrolled ?? current.trustEnrolled,
        allProjects: patch.allProjects ?? current.allProjects,
        autoConfigured: patch.autoConfigured ?? current.autoConfigured,
        notify: patch.notify ?? current.notify,
        maxMode: patch.maxMode !== undefined ? patch.maxMode : current.maxMode,
        allowedSenders: patch.allowedSenders ?? current.allowedSenders,
        allowedProjects: patch.allowedProjects ?? current.allowedProjects,
        masterProjectId: "masterProjectId" in patch ? patch.masterProjectId : current.masterProjectId,
        masterModelSelection: "masterModelSelection" in patch ? patch.masterModelSelection : current.masterModelSelection,
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
