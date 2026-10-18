import { join, resolve } from "node:path";

import { assertSupportedPlatform } from "./platform.js";

export interface PlatformPathOptions {
  platform: NodeJS.Platform;
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  xdgStateHome?: string;
}

export interface YouBrainPaths {
  dataDir: string;
  outputDir: string;
  configFile: string;
  stateFile: string;
  searchIndexFile: string;
  modelCacheDir: string;
  daemonFile: string;
  lockFile: string;
  todayFile: string;
  topicsFile: string;
  remindersFile: string;
  portraitDir: string;
}

function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}

function resolveUserPath(value: string, homeDir: string): string {
  return resolve(expandHome(value, homeDir));
}

function nonempty(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

function defaultDataDir(
  options: PlatformPathOptions,
  env: NodeJS.ProcessEnv,
): string {
  if (options.platform === "darwin") {
    return join(options.homeDir, "Library", "Application Support", "you-brain");
  }
  const stateHome =
    options.xdgStateHome ??
    nonempty(env, "XDG_STATE_HOME") ??
    join(options.homeDir, ".local", "state");
  return join(stateHome, "you-brain");
}

export function platformPaths(options: PlatformPathOptions): YouBrainPaths {
  assertSupportedPlatform(options.platform);
  const env = options.env ?? process.env;
  const dataOverride = nonempty(env, "YOU_BRAIN_DATA_DIR");
  const outputOverride = nonempty(env, "YOU_BRAIN_HOME");
  const dataDir = dataOverride
    ? resolveUserPath(dataOverride, options.homeDir)
    : resolve(defaultDataDir(options, env));
  const outputDir = outputOverride
    ? resolveUserPath(outputOverride, options.homeDir)
    : resolve(join(options.homeDir, ".you-brain"));
  return {
    dataDir,
    outputDir,
    configFile: join(dataDir, "config.toml"),
    stateFile: join(dataDir, "state.sqlite"),
    searchIndexFile: join(dataDir, "search-index.sqlite"),
    modelCacheDir: join(dataDir, "models"),
    daemonFile: join(dataDir, "daemon.json"),
    lockFile: join(dataDir, "daemon.lock"),
    todayFile: join(outputDir, "TODAY.md"),
    topicsFile: join(outputDir, "TOPICS.md"),
    remindersFile: join(outputDir, "REMINDERS.md"),
    portraitDir: join(outputDir, "portrait"),
  };
}

export function portraitFile(paths: YouBrainPaths, variant: string): string {
  if (
    variant.length === 0 ||
    variant === "." ||
    variant === ".." ||
    variant.includes("/") ||
    variant.includes("\\") ||
    variant.includes("\0")
  ) {
    throw new Error("Invalid portrait variant");
  }
  return join(paths.portraitDir, `${variant}.md`);
}
