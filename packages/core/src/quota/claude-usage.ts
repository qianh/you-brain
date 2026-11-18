import { execFile } from "node:child_process";

import { SECRETS_FILE_ENV } from "../auth/secret-store-factory.js";
import { MAGPIE_TIMEOUT_MS } from "./magpie.js";

/**
 * Anthropic's own usage endpoint, the same one Claude Code's /usage panel reads: live
 * five-hour and seven-day utilization for the signed-in subscription. magpie only
 * carries Claude Code's cached copy, which goes stale when no traffic runs through
 * Anthropic itself.
 */
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** macOS keychain item Claude Code keeps its OAuth credentials in. */
const KEYCHAIN_SERVICE = "Claude Code-credentials";

export interface ClaudeUsageWindows {
  fiveHour: number | null;
  sevenDay: number | null;
  /** One window per capped model magpie exposes: "seven_day_opus", "seven_day_omelette" … */
  models: Record<string, number>;
}

/**
 * Reads Claude Code's OAuth access token from the keychain. Rejects when the item is
 * missing or unreadable. The token is returned to the caller only — it never lands in
 * a log, an error message, or a stored file.
 */
export function readClaudeAccessToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env[SECRETS_FILE_ENV]?.trim()) {
    return Promise.reject(new Error("没有找到 Claude Code 的钥匙串凭据"));
  }
  return new Promise((resolve, reject) => {
    execFile(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: MAGPIE_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          reject(new Error("没有找到 Claude Code 的钥匙串凭据"));
          return;
        }
        try {
          const token = (JSON.parse(stdout) as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth
            ?.accessToken;
          if (typeof token !== "string" || token === "") throw new Error("凭据里没有访问令牌");
          resolve(token);
        } catch (cause) {
          reject(cause instanceof Error ? new Error("凭据无法解析") : cause);
        }
      },
    );
  });
}

/** Fetches the live usage window. Rejects on any failure; the caller decides what to keep. */
export async function readClaudeUsage(token: string, signal?: AbortSignal): Promise<ClaudeUsageWindows> {
  const response = await fetch(USAGE_URL, {
    headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new ClaudeUsageError(`usage 探测返回 ${response.status}`, response);
  const value = (await response.json()) as unknown;
  // The endpoint lists the windows at the top level: {"five_hour":{...},"seven_day":{...}}.
  if (!isRecord(value)) throw new Error("usage 输出无法解析");
  const utilization = value;
  const used = (name: string): number | null => {
    const window = utilization[name];
    const percent = isRecord(window) ? window.utilization : undefined;
    return typeof percent === "number" && Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null;
  };
  const models: Record<string, number> = {};
  for (const [name, window] of Object.entries(utilization)) {
    const percent = isRecord(window) ? window.utilization : undefined;
    if (typeof percent === "number" && Number.isFinite(percent) && name.startsWith("seven_day_") && name !== "seven_day_oauth_apps") {
      models[name] = Math.min(100, Math.max(0, percent));
    }
  }
  return { fiveHour: used("five_hour"), sevenDay: used("seven_day"), models };
}

/** A failed probe with its rate-limit hints, so the caller can back off instead of hammering. */
export class ClaudeUsageError extends Error {
  /** HTTP status; undefined when the failure was not an HTTP response. */
  readonly status: number | undefined;
  /** The Retry-After header in milliseconds, when the server sent one. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, response?: Response) {
    super(message);
    this.name = "ClaudeUsageError";
    this.status = response?.status;
    const retryAfterSeconds = response ? Number(response.headers.get("retry-after")) : Number.NaN;
    this.retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
