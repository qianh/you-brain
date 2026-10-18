import { readFile } from "node:fs/promises";

import {
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
 * A local setup may already name a model while Drive still has the empty
 * default. Keep the local model until the remote file actually sets one.
 */
export function preferLocalLlm(remote: SharedConfig, local: SharedConfig): SharedConfig {
  if (remote.llm.model.trim() === "" && local.llm.model.trim() !== "") {
    return { ...remote, llm: { ...local.llm } };
  }
  return remote;
}
