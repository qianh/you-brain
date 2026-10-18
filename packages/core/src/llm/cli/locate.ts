import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LlmProvider } from "@you-brain/protocol";

export const CLI_PROVIDERS = [
  "grok-cli",
  "claude-cli",
  "codex-cli",
  "gemini-cli",
  "opencode-cli",
] as const;

export type CliProvider = (typeof CLI_PROVIDERS)[number];

export function isCliProvider(provider: string): provider is CliProvider {
  return (CLI_PROVIDERS as readonly string[]).includes(provider);
}

const COMMANDS: Record<CliProvider, string> = {
  "grok-cli": "grok",
  "claude-cli": "claude",
  "codex-cli": "codex",
  "gemini-cli": "gemini",
  "opencode-cli": "opencode",
};

const LOGIN_COMMANDS: Record<CliProvider, string> = {
  "grok-cli": "grok login",
  "claude-cli": "claude auth login",
  "codex-cli": "codex login",
  "gemini-cli": "gemini 并执行 /auth",
  "opencode-cli": "opencode auth login",
};

export function cliLoginCommand(provider: CliProvider): string {
  return LOGIN_COMMANDS[provider];
}

export function cliCommandName(provider: LlmProvider): string {
  if (!isCliProvider(provider)) return provider;
  return COMMANDS[provider];
}

export function cliEnvVar(provider: CliProvider): string {
  return `YOU_BRAIN_${COMMANDS[provider].toUpperCase()}_BIN`;
}

export function cliFallbacks(provider: CliProvider, homeDir: string): string[] {
  switch (provider) {
    case "grok-cli":
      return [join(homeDir, ".local", "bin", "grok"), join(homeDir, ".grok", "bin", "grok")];
    case "claude-cli":
      return [join(homeDir, ".local", "bin", "claude")];
    case "codex-cli":
      return [
        "/usr/local/bin/codex",
        "/opt/homebrew/bin/codex",
        join(homeDir, ".local", "bin", "codex"),
      ];
    case "gemini-cli":
      return [
        "/opt/homebrew/bin/gemini",
        "/usr/local/bin/gemini",
        join(homeDir, ".local", "bin", "gemini"),
      ];
    case "opencode-cli":
      return [
        join(homeDir, ".opencode", "bin", "opencode"),
        join(homeDir, ".local", "bin", "opencode"),
      ];
    default: {
      const never: never = provider;
      return never;
    }
  }
}

export function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function searchPath(command: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(":")) {
    if (dir.trim() === "") continue;
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export interface LocateCliOptions {
  provider: CliProvider;
  /** Authoritative. When set, PATH and fallbacks are not consulted. */
  bin?: string;
  /** Lookup environment. When set, PATH is read only from this object. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/**
 * Injected path, then YOU_BRAIN_<NAME>_BIN, then PATH, then known install locations.
 * A non-empty injected path or env var that is not executable does not fall through.
 */
export function locateCliBinary(options: LocateCliOptions): string | null {
  if (options.bin !== undefined && options.bin.trim() !== "") {
    const injected = options.bin.trim();
    return isExecutable(injected) ? injected : null;
  }
  const env = options.env ?? process.env;
  const fromEnv = env[cliEnvVar(options.provider)];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const configured = fromEnv.trim();
    return isExecutable(configured) ? configured : null;
  }
  const pathEnv = options.env !== undefined ? (options.env.PATH ?? "") : (process.env.PATH ?? "");
  const onPath = searchPath(COMMANDS[options.provider], pathEnv);
  if (onPath) return onPath;
  const home = options.homeDir ?? homedir();
  for (const candidate of cliFallbacks(options.provider, home)) {
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}
