import { describe, expect, it } from "bun:test";
import { LlmProviderSchema } from "@you-brain/protocol";

import { createLlmBackend } from "../../src/llm/factory.js";

const provider = process.env.YB_SMOKE_PROVIDER;

/**
 * Opt-in live call. Skipped unless the environment is set:
 * YB_SMOKE_PROVIDER (required), YB_SMOKE_API_KEY (required except ollama),
 * YB_SMOKE_MODEL, YB_SMOKE_BASE_URL.
 */
describe.skipIf(!provider)("live model smoke", () => {
  it("reaches the configured provider", async () => {
    const parsed = LlmProviderSchema.parse(provider);
    const backend = await createLlmBackend({
      config: {
        provider: parsed,
        model: process.env.YB_SMOKE_MODEL ?? "",
        baseUrl: process.env.YB_SMOKE_BASE_URL ?? "",
      },
      getApiKey: () => process.env.YB_SMOKE_API_KEY,
      timeoutMs: 60_000,
    });
    await backend.test();
  }, 90_000);
});
