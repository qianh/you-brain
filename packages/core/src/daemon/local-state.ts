import { readFile } from "node:fs/promises";

import {
  createDefaultSharedConfig,
  parseRoles,
  parseSharedConfig,
  type Roles,
  type SharedConfig,
} from "@you-brain/protocol";

import { writeFileAtomic } from "../domain/atomic.js";

export async function readJsonFile<T>(
  path: string,
  parse: (value: unknown) => T,
  fallback: T,
): Promise<T> {
  try {
    return parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return fallback;
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function readSharedFile(path: string, fallback: SharedConfig): Promise<SharedConfig> {
  return readJsonFile(path, (value) => parseSharedConfig(value), fallback);
}

export function readRolesFile(path: string, fallback: Roles): Promise<Roles> {
  return readJsonFile(path, (value) => parseRoles(value), fallback);
}

/**
 * 模型（`llm`、`consolidateLlm`）由各设备自己维护，不跟随 Drive：
 * 同步下来的 shared.json 只取其余字段，模型始终保留本机的。
 */
export function keepLocalLlm(remote: SharedConfig, local: SharedConfig): SharedConfig {
  return { ...remote, llm: { ...local.llm }, consolidateLlm: { ...local.consolidateLlm } };
}

/** 推到 Drive 的补丁不带模型字段：本机改模型不能改动其他设备（含尚未升级的旧版本）。 */
export function sharedWithoutLlm(config: SharedConfig): Omit<SharedConfig, "llm" | "consolidateLlm"> {
  const { llm: _llm, consolidateLlm: _consolidateLlm, ...rest } = config;
  return rest;
}
