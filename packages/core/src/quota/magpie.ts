import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCliProcess } from "../llm/cli/exec.js";
import { isExecutable } from "../llm/cli/locate.js";

export const MAGPIE_BIN_ENV = "YOU_BRAIN_MAGPIE_BIN";
/** One read asks every provider in turn and takes about ten seconds. */
export const MAGPIE_TIMEOUT_MS = 30_000;

/** `YOU_BRAIN_MAGPIE_BIN` wins (and, if not runnable, means "no magpie"); then PATH; then the usual spots. */
export function locateMagpie(input: { env: NodeJS.ProcessEnv; homeDir: string }): string | null {
  const configured = input.env[MAGPIE_BIN_ENV]?.trim();
  if (configured) return isExecutable(configured) ? configured : null;
  const candidates = [
    ...(input.env.PATH ?? "").split(":").filter((dir) => dir.trim() !== "").map((dir) => join(dir, "magpie")),
    join(input.homeDir, ".local", "bin", "magpie"),
    "/opt/homebrew/bin/magpie",
    "/usr/local/bin/magpie",
  ];
  return candidates.find(isExecutable) ?? null;
}

/** Runs `magpie accounts --json`. Rejects when magpie is missing, slow, or exits non-zero. */
export async function readMagpieAccounts(input: {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  signal?: AbortSignal;
}): Promise<string> {
  return runMagpie(["accounts", "--json"], input);
}

async function runMagpie(args: readonly string[], input: { env: NodeJS.ProcessEnv; homeDir: string; signal?: AbortSignal }): Promise<string> {
  const bin = locateMagpie(input);
  if (bin === null) throw new Error("没有找到 magpie");
  const result = await runCliProcess({
    bin,
    args: [...args],
    cwd: tmpdir(),
    timeoutMs: MAGPIE_TIMEOUT_MS,
    env: input.env,
    secrets: [],
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (result.exitCode !== 0) throw new Error(`magpie 退出码 ${result.exitCode}`);
  return result.stdout;
}
