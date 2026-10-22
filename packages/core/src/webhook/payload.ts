import type { Event } from "@you-brain/protocol";

export interface WebhookPayload {
  id: string;
  type: string;
  occurredAt: string;
  deviceId: string;
  data: unknown;
}

/** Stable key order. The signature covers this exact string. */
export function encodeWebhookBody(payload: WebhookPayload): string {
  return JSON.stringify({
    id: payload.id,
    type: payload.type,
    occurredAt: payload.occurredAt,
    deviceId: payload.deviceId,
    data: payload.data,
  });
}

export function eventToPayload(event: Event): WebhookPayload {
  return {
    id: event.id,
    type: event.type,
    occurredAt: event.ts,
    deviceId: event.device,
    data: event.data,
  };
}
