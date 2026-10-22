import { z } from "zod";

/** Event types a webhook subscription can include. Defaults to all of them. */
export const WEBHOOK_EVENT_KINDS = [
  "reminder.issued",
  "topic.created",
  "topic.status_changed",
  "topic.merged",
] as const;

export const WebhookEventKindSchema = z.enum(WEBHOOK_EVENT_KINDS);

export type WebhookEventKind = z.infer<typeof WebhookEventKindSchema>;
