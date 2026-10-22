import { stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { YouBrainError } from "../../src/domain/errors.js";
import {
  applyWebhookUpdate,
  defaultWebhookConfig,
  readWebhookConfig,
  webhookConfigPath,
  writeWebhookConfig,
  type WebhookConfig,
} from "../../src/webhook/config.js";

const URL = "https://hooks.example/you-brain";

function current(patch?: Partial<WebhookConfig>): WebhookConfig {
  return { ...defaultWebhookConfig(), secret: "kept", url: URL, ...patch };
}

describe("webhook config", () => {
  test("rejects userinfo, non-http URLs, and over-long URLs", () => {
    expect(() => applyWebhookUpdate(current(), { url: "https://user:pass@hooks.example/hook" })).toThrow(
      YouBrainError,
    );
    expect(() => applyWebhookUpdate(current(), { url: "ftp://hooks.example/hook" })).toThrow(
      "URL 必须是 http 或 https",
    );
    expect(() => applyWebhookUpdate(current(), { url: "not a url" })).toThrow("URL 必须是 http 或 https");
    const huge = `https://hooks.example/${"a".repeat(2048)}`;
    expect(huge.length).toBeGreaterThan(2048);
    expect(() => applyWebhookUpdate(current(), { url: huge })).toThrow("URL 最长 2048 个字符");
  });

  test("requires a valid URL only when enabling", () => {
    expect(applyWebhookUpdate(current({ url: "", enabled: false }), { url: "" }).url).toBe("");
    expect(() => applyWebhookUpdate(current({ url: "", enabled: false }), { enabled: true })).toThrow(
      "启用时需要有效的 Webhook URL",
    );
    expect(() => applyWebhookUpdate(current({ enabled: false, url: "" }), { url: "ftp://hooks.example" })).toThrow(
      "URL 必须是 http 或 https",
    );
  });

  test("keeps, clears, or replaces the secret", () => {
    expect(applyWebhookUpdate(current(), { url: `  ${URL}  ` }).secret).toBe("kept");
    expect(applyWebhookUpdate(current(), {}).secret).toBe("kept");
    expect(applyWebhookUpdate(current(), { secret: "" }).secret).toBe("");
    expect(applyWebhookUpdate(current(), { secret: "next" }).secret).toBe("next");
    expect(applyWebhookUpdate(current(), { secret: " " }).secret).toBe(" ");
  });

  test("dedupes events and preserves the first-seen order", () => {
    const next = applyWebhookUpdate(current(), {
      events: ["topic.merged", "reminder.issued", "topic.merged"],
    });
    expect(next.events).toEqual(["topic.merged", "reminder.issued"]);
  });

  test("writes webhook.json with mode 0600 and reads the secret back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "you-brain-webhook-config-"));
    const path = webhookConfigPath(dir);
    const missing = await readWebhookConfig(path);
    expect(missing).toEqual(defaultWebhookConfig());
    const stored = applyWebhookUpdate(defaultWebhookConfig(), {
      enabled: true,
      url: URL,
      secret: "s3cret",
      events: ["reminder.issued"],
    });
    await writeWebhookConfig(path, stored);
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
    const read = await readWebhookConfig(path);
    expect(read.secret).toBe("s3cret");
    expect(read.enabled).toBe(true);
    expect(JSON.stringify(read)).not.toContain("hasSecret");
  });
});
