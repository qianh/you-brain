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

function sameLlm(left: SharedConfig["llm"], right: SharedConfig["llm"]): boolean {
  return left.provider === right.provider && left.model === right.model && left.baseUrl === right.baseUrl;
}

/**
 * Drive may still hold the factory default while this machine already chose a
 * provider. CLI providers leave the model blank on purpose, so an empty model
 * string is not "unconfigured". Keep the local provider until the remote file
 * actually names one. A remote file that names no model still yields to a
 * local model string.
 */
export function preferLocalLlm(remote: SharedConfig, local: SharedConfig): SharedConfig {
  const fallback = createDefaultSharedConfig().llm;
  if (sameLlm(remote.llm, fallback) && !sameLlm(local.llm, fallback)) {
    return { ...remote, llm: { ...local.llm } };
  }
  if (remote.llm.model.trim() === "" && local.llm.model.trim() !== "") {
    return { ...remote, llm: { ...local.llm } };
  }
  return remote;
}
