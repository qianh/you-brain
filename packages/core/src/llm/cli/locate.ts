import { spawn } from "node:child_process";
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

/** Shell command the user runs to sign in. Checked against each CLI's --help. */
const LOGIN_COMMANDS: Record<CliProvider, string> = {
  "grok-cli": "grok login",
  "claude-cli": "claude（交互里 /login）",
  "codex-cli": "codex login",
  "gemini-cli": "gemini（交互里完成登录）",
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

function searchPathAll(command: string, pathEnv: string): string[] {
  const found: string[] = [];
  for (const dir of pathEnv.split(":")) {
    if (dir.trim() === "") continue;
    const candidate = join(dir, command);
    if (isExecutable(candidate) && !found.includes(candidate)) found.push(candidate);
  }
  return found;
}

function candidatePaths(options: LocateCliOptions): string[] {
  if (options.bin !== undefined && options.bin.trim() !== "") {
    const injected = options.bin.trim();
    return isExecutable(injected) ? [injected] : [];
  }
  const env = options.env ?? process.env;
  const fromEnv = env[cliEnvVar(options.provider)];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const configured = fromEnv.trim();
    return isExecutable(configured) ? [configured] : [];
  }
  const pathEnv = options.env !== undefined ? (options.env.PATH ?? "") : (process.env.PATH ?? "");
  const found = searchPathAll(COMMANDS[options.provider], pathEnv);
  const home = options.homeDir ?? homedir();
  const fallbacks = options.fallbacks ?? cliFallbacks(options.provider, home);
  for (const candidate of fallbacks) {
    if (isExecutable(candidate) && !found.includes(candidate)) found.push(candidate);
  }
  return found;
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, 500);
  timer.unref();
}

function probeEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env ? { ...process.env, ...env } : process.env;
}

export function probeCliVersion(
  bin: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, detail });
    };
    let child;
    try {
      child = spawn(bin, ["--version"], {
        env: probeEnv(env),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法运行";
      resolve({ ok: false, detail: message });
      return;
    }
    const timer = setTimeout(() => {
      if ((child.pid ?? 0) > 0) killProcessGroup(child.pid ?? 0);
      finish(false, "超时");
    }, CLI_VERSION_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-4096);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.on("error", (error) => {
      if ((child.pid ?? 0) > 0) killProcessGroup(child.pid ?? 0);
      finish(false, error.message);
    });
    child.on("close", (code) => {
      if (code === 0) finish(true, "");
      else finish(false, cliRunFailureLine(stderr, stdout));
    });
  });
}

export interface LocateCliOptions {
  provider: CliProvider;
  /** Authoritative. When set, PATH and fallbacks are not consulted. */
  bin?: string;
  /** Lookup environment. When set, PATH is read only from this object. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Replaces the built-in install locations. Tests pass [] to ignore a real binary. */
  fallbacks?: readonly string[];
}

export interface CliProbeFailure {
  path: string;
  detail: string;
}

export interface LocatedCli {
  bin: string | null;
  unusable: CliProbeFailure[];
}

export const CLI_VERSION_TIMEOUT_MS = 5_000;

export function cliNoResponseMessage(command: string, timeoutMs: number, login: string): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return `${command} 在 ${seconds} 秒内没有响应。可能是服务暂时不可用，或需要重新登录（请运行 ${login}）。可稍后重试。`;
}

export function formatUnusableCli(failures: readonly CliProbeFailure[]): string {
  const paths = failures.map((failure) => failure.path).join("、");
  const detail = failures[0]?.detail || "无法运行";
  return `找到了 ${paths}，但无法运行：${detail}`;
}

/** One line from a failed `--version`, skipping stack frames. */
export function cliRunFailureLine(stderr: string, stdout: string): string {
  const lines = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const error = lines.find((line) => /^Error:/u.test(line));
  if (error) return error;
  const plain = lines.find((line) => !isStackNoise(line));
  if (plain) return plain;
  const out = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line !== "");
  return out ?? "无法运行";
}

function isStackNoise(line: string): boolean {
  return (
    line.startsWith("at ") ||
    line.startsWith("file://") ||
    line === "^" ||
    line.startsWith("throw ") ||
    /^Node\.js v/u.test(line)
  );
}

/**
 * Injected path, then YOU_BRAIN_<NAME>_BIN, then PATH, then known install locations.
 * A non-empty injected path or env var that is not executable does not fall through.
 */
export function locateCliBinary(options: LocateCliOptions): string | null {
  return candidatePaths(options)[0] ?? null;
}

/** First candidate whose `--version` exits 0 within 5 seconds. Broken ones are skipped. */
export async function locateRunnableCli(options: LocateCliOptions): Promise<LocatedCli> {
  const paths = candidatePaths(options);
  const unusable: CliProbeFailure[] = [];
  for (const path of paths) {
    const probe = await probeCliVersion(path, options.env);
    if (probe.ok) return { bin: path, unusable };
    unusable.push({ path, detail: probe.detail });
    const pinned =
      (options.bin !== undefined && options.bin.trim() !== "") ||
      (() => {
        const env = options.env ?? process.env;
        const fromEnv = env[cliEnvVar(options.provider)];
        return fromEnv !== undefined && fromEnv.trim() !== "";
      })();
    if (pinned) break;
  }
  return { bin: null, unusable };
}
