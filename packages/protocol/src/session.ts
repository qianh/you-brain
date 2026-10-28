import { createHash } from "node:crypto";

import { z } from "zod";

export const CAPTURE_SOURCE_IDS = [
  "claude-code",
  "codex",
  "grok-build",
  "cursor",
  "gemini-cli",
  "pi",
  "t3-code",
  "zcode",
] as const;

export const CaptureSourceIdSchema = z.enum(CAPTURE_SOURCE_IDS);

export type CaptureSourceId = z.infer<typeof CaptureSourceIdSchema>;

export const SessionKeySchema = z.string().regex(/^[a-f0-9]{64}$/u);

export function conversationKey(source: string, conversationId: string): string {
  return createHash("sha256")
    .update(source)
    .update("\0")
    .update(conversationId)
    .digest("hex");
}
