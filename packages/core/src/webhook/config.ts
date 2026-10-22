import { join } from "node:path";

import { z } from "zod";

import { YouBrainError } from "../domain/errors.js";
import { readJsonFile, writeJsonFile } from "../daemon/local-state.js";
import { WEBHOOK_EVENT_KINDS, type WebhookEventKind } from "./kinds.js";

export const WEBHOOK_URL_MAX = 2048;

export interface WebhookConfig {
  enabled: boolean;
  url: string;
  secret: string;
  events: WebhookEventKind[];
}

const StoredWebhookSchema = z.object({
  enabled: z.boolean(),
  url: z.string(),
  secret: z.string(),
  events: z.array(z.enum(WEBHOOK_EVENT_KINDS)),
});

export function webhookConfigPath(dataDir: string): string {
  return join(dataDir, "webhook.json");
}

export function defaultWebhookConfig(): WebhookConfig {
  return {
    enabled: false,
    url: "",
    secret: "",
    events: [...WEBHOOK_EVENT_KINDS],
  };
}

/** `null` when the URL is acceptable. Empty is not acceptable here. */
export function webhookUrlProblem(url: string): string | null {
  if (url.length > WEBHOOK_URL_MAX) return "URL 最长 2048 个字符";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "URL 必须是 http 或 https";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "URL 必须是 http 或 https";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "URL 不能包含用户名或密码";
  }
  if (parsed.host === "") return "URL 必须是 http 或 https";
  return null;
}

export function parseWebhookConfig(value: unknown): WebhookConfig {
  const parsed = StoredWebhookSchema.parse(value);
  return {
    enabled: parsed.enabled,
    url: parsed.url,
    secret: parsed.secret,
    events: dedupeEvents(parsed.events),
  };
}

export function readWebhookConfig(path: string): Promise<WebhookConfig> {
  return readJsonFile(path, parseWebhookConfig, defaultWebhookConfig());
}

export function writeWebhookConfig(path: string, config: WebhookConfig): Promise<void> {
  return writeJsonFile(path, {
    enabled: config.enabled,
    url: config.url,
    secret: config.secret,
    events: config.events,
  });
}

export interface WebhookUpdate {
  enabled?: boolean;
  url?: string;
  /** Omitted keeps the stored secret. `""` clears it. Anything else replaces it. */
  secret?: string;
  events?: readonly WebhookEventKind[];
}

/**
 * Merge a PUT body onto the stored config.
 * Enabling requires a valid URL. A non-empty URL is checked even when disabled.
 */
export function applyWebhookUpdate(current: WebhookConfig, patch: WebhookUpdate): WebhookConfig {
  const url = patch.url !== undefined ? patch.url.trim() : current.url;
  const enabled = patch.enabled ?? current.enabled;
  const events = patch.events !== undefined ? dedupeEvents(patch.events) : [...current.events];
  const secret = patch.secret !== undefined ? patch.secret : current.secret;
  if (url !== "") {
    const problem = webhookUrlProblem(url);
    if (problem) throw new YouBrainError("INVALID_INPUT", problem);
  } else if (enabled) {
    throw new YouBrainError("INVALID_INPUT", "启用时需要有效的 Webhook URL");
  }
  return { enabled, url, secret, events };
}

function dedupeEvents(events: readonly WebhookEventKind[]): WebhookEventKind[] {
  const seen = new Set<string>();
  const unique: WebhookEventKind[] = [];
  for (const event of events) {
    if (seen.has(event)) continue;
    seen.add(event);
    unique.push(event);
  }
  return unique;
}
