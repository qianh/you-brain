import { describe, expect, test } from "bun:test";

import { signWebhook, webhookHeaders } from "../../src/webhook/sign.js";

const SECRET = "top-secret";
const TIMESTAMP_SECONDS = 1_700_000_000;
const BODY =
  '{"id":"01ARYZ6S41TSV4RRFFQ69G5FAV","type":"reminder.issued","occurredAt":"2023-11-14T22:13:20.000Z","deviceId":"device-1","data":{"reminderId":"morning:2023-11-14","kind":"morning_digest","topicId":null,"text":"hello"}}';
const HEX = "59253db69c73c8760db5e06a99d377450796953176054989d8908363d557543d";

describe("webhook signature", () => {
  test("matches the known HMAC-SHA256 vector", () => {
    expect(signWebhook(SECRET, TIMESTAMP_SECONDS, BODY)).toBe(HEX);
  });

  test("puts v1=<hex> on the signature header", () => {
    const headers = webhookHeaders({
      eventType: "reminder.issued",
      deliveryId: "01ARYZ6S41TSV4RRFFQ69G5FAV",
      timestampSeconds: TIMESTAMP_SECONDS,
      secret: SECRET,
      body: BODY,
    });
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("X-YouBrain-Event")).toBe("reminder.issued");
    expect(headers.get("X-YouBrain-Delivery")).toBe("01ARYZ6S41TSV4RRFFQ69G5FAV");
    expect(headers.get("X-YouBrain-Timestamp")).toBe(String(TIMESTAMP_SECONDS));
    expect(headers.get("X-YouBrain-Signature")).toBe(`v1=${HEX}`);
  });

  test("omits the signature header when the secret is empty", () => {
    const headers = webhookHeaders({
      eventType: "webhook.test",
      deliveryId: "test-1",
      timestampSeconds: TIMESTAMP_SECONDS,
      secret: "",
      body: "{}",
    });
    expect(headers.get("X-YouBrain-Signature")).toBeNull();
    expect(headers.get("X-YouBrain-Timestamp")).toBe(String(TIMESTAMP_SECONDS));
  });
});
