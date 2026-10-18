import { spawn } from "node:child_process";

import { LlmRequestError, type LlmErrorKind } from "../errors.js";

export const DEFAULT_CLI_TIMEOUT_MS = 300_000;

const STDOUT_CAP = 4 * 1024 * 1024;
const STDERR_CAP = 64 * 1024;

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CliRunOptions {
  bin: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  secrets: readonly string[];
}

let tail: Promise<void> = Promise.resolve();

/** One subscription CLI at a time, across every driver in this process. */
export function withCliSlot<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length < 16 || !output.includes(secret)) continue;
    output = output.split(secret).join("[redacted]");
  }
  return output;
}

export function cliFailure(
  kind: LlmErrorKind,
  message: string,
  stderr: string,
  secrets: readonly string[],
): LlmRequestError {
  const detail = redactSecrets(stderr, secrets).slice(-500).trim();
  const text = detail === "" ? message : `${message}\n${detail}`;
  return new LlmRequestError(kind, text);
}

function appendCapped(current: string, chunk: string, cap: number): string {
  const next = current + chunk;
  if (next.length <= cap) return next;
  return next.slice(next.length - cap);
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

export function runCliProcess(options: CliRunOptions): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let childPid = 0;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const fail = (error: LlmRequestError): void => {
      if (childPid > 0) killProcessGroup(childPid);
      finish(() => reject(error));
    };
    const onAbort = (): void => {
      fail(cliFailure("client", "已取消", stderr, options.secrets));
    };

    let child;
    try {
      child = spawn(options.bin, options.args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "命令启动失败";
      reject(
        new LlmRequestError(
          "client",
          `命令启动失败：${redactSecrets(message, options.secrets)}`,
        ),
      );
      return;
    }
    childPid = child.pid ?? 0;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendCapped(stdout, chunk, STDOUT_CAP);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk, STDERR_CAP);
    });
    child.stdin?.on("error", () => {
      // The process can exit before stdin finishes.
    });
    child.stdin?.end(options.stdin ?? "");

    const timer = setTimeout(() => {
      fail(cliFailure("network", "请求超时", stderr, options.secrets));
    }, options.timeoutMs);

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (error) => {
      fail(
        new LlmRequestError(
          "client",
          `命令启动失败：${redactSecrets(error.message, options.secrets)}`,
        ),
      );
    });
    child.on("close", (code) => {
      finish(() => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
    });
  });
}
