export const WEBHOOK_EVENT_NAMES = [
  "reminder.issued",
  "topic.created",
  "topic.status_changed",
  "topic.merged",
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENT_NAMES)[number];

export type WebhookSecretMode = "keep" | "replace" | "clear";

export type WebhookUrlIssue = "required" | "long" | "invalid" | "userinfo";

const URL_MAX = 2048;

/** Empty is allowed only while the webhook stays off. */
export function webhookUrlIssue(url: string, enabled: boolean): WebhookUrlIssue | null {
  const trimmed = url.trim();
  if (trimmed === "") return enabled ? "required" : null;
  if (trimmed.length > URL_MAX) return "long";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "invalid";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "invalid";
  if (parsed.username !== "" || parsed.password !== "") return "userinfo";
  if (parsed.host === "") return "invalid";
  return null;
}

/**
 * Body for `PUT /api/webhook`.
 * `keep` omits `secret`. `clear` sends `""`. `replace` sends the new value, or omits it when blank.
 */
export function webhookSaveBody(input: {
  enabled: boolean;
  url: string;
  events: readonly WebhookEventName[];
  secretMode: WebhookSecretMode;
  secret: string;
}): {
  enabled: boolean;
  url: string;
  events: WebhookEventName[];
  secret?: string;
} {
  const body = {
    enabled: input.enabled,
    url: input.url.trim(),
    events: WEBHOOK_EVENT_NAMES.filter((kind) => input.events.includes(kind)),
  };
  if (input.secretMode === "clear") return { ...body, secret: "" };
  if (input.secretMode === "replace" && input.secret !== "") return { ...body, secret: input.secret };
  return body;
}
