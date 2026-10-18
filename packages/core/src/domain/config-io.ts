import { readFile } from "node:fs/promises";
import { hostname as osHostname } from "node:os";

import TOML from "@iarna/toml";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.js";
import {
  createDefaultLocalConfig,
  LocalConfigSchema,
  platformPaths,
  type LocalConfig,
  type YouBrainPaths,
} from "./config.js";
import { YouBrainError } from "./errors.js";

function camelKey(value: string): string {
  return value.replace(/_([a-z])/gu, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}

function snakeKey(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

function mapKeys(value: unknown, keyMapper: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => mapKeys(item, keyMapper));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      keyMapper(key),
      mapKeys(child, keyMapper),
    ]),
  );
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export interface LoadedLocalConfig {
  config: LocalConfig;
  paths: YouBrainPaths;
  configFile: string;
  created: boolean;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

function parseStoredConfig(text: string): LocalConfig {
  try {
    return LocalConfigSchema.parse(mapKeys(TOML.parse(text), camelKey));
  } catch (error) {
    if (error instanceof YouBrainError) throw error;
    const message =
      error instanceof z.ZodError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Invalid local config";
    throw new YouBrainError("CONFIG_INVALID", message);
  }
}

async function readDeviceId(path: string): Promise<string | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  const config = parseStoredConfig(text);
  return config.deviceId;
}

export async function writeLocalConfig(
  path: string,
  config: LocalConfig,
): Promise<void> {
  const validated = LocalConfigSchema.parse(config);
  const current = await readDeviceId(path);
  if (current !== undefined && current !== validated.deviceId) {
    throw new YouBrainError(
      "DEVICE_ID_IMMUTABLE",
      "deviceId cannot be changed once it has been written",
    );
  }
  const serializable = mapKeys(validated, snakeKey) as TOML.JsonMap;
  await writeFileAtomic(path, TOML.stringify(serializable), { mode: 0o600 });
}

export async function loadLocalConfig(options: {
  homeDir: string;
  platform: NodeJS.Platform;
  hostname?: string;
  env?: NodeJS.ProcessEnv;
  configFile?: string;
}): Promise<LoadedLocalConfig> {
  const env = options.env ?? process.env;
  const paths = platformPaths({
    platform: options.platform,
    homeDir: options.homeDir,
    env,
  });
  const configFile = options.configFile ?? paths.configFile;
  const text = await readText(configFile);
  if (text === undefined) {
    const config = createDefaultLocalConfig({
      hostname: options.hostname ?? osHostname(),
      dataDir: paths.dataDir,
    });
    await writeLocalConfig(configFile, config);
    return { config, paths, configFile, created: true };
  }
  const stored = parseStoredConfig(text);
  return {
    config: { ...stored, dataDir: paths.dataDir },
    paths,
    configFile,
    created: false,
  };
}
