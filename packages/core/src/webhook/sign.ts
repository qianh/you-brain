import { createHmac } from "node:crypto";

/** Lowercase hex HMAC-SHA256 over `<unix seconds>.<raw body>`. */
export function signWebhook(secret: string, timestampSeconds: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
}

/**
 * Headers for one delivery. An empty secret omits `X-YouBrain-Signature`.
 * `timestampSeconds` is the same integer the signature covers.
 */
export function webhookHeaders(input: {
  eventType: string;
  deliveryId: string;
  timestampSeconds: number;
  secret: string;
  body: string;
}): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("X-YouBrain-Event", input.eventType);
  headers.set("X-YouBrain-Delivery", input.deliveryId);
  headers.set("X-YouBrain-Timestamp", String(input.timestampSeconds));
  if (input.secret !== "") {
    headers.set(
      "X-YouBrain-Signature",
      `v1=${signWebhook(input.secret, input.timestampSeconds, input.body)}`,
    );
  }
  return headers;
}
