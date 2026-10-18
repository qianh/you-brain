import { createDefaultSharedConfig, parseSharedConfig } from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import { preferLocalLlm } from "../../src/daemon/local-state.js";

describe("preferLocalLlm", () => {
  it("keeps a blank-model CLI provider when Drive still has the factory default", () => {
    const local = parseSharedConfig({ llm: { provider: "codex-cli", model: "", baseUrl: "" } });
    const merged = preferLocalLlm(createDefaultSharedConfig(), local);
    expect(merged.llm).toEqual(local.llm);
  });

  it("keeps a local model string when the remote names none", () => {
    const local = parseSharedConfig({
      llm: { provider: "deepseek", model: "deepseek-chat", baseUrl: "" },
    });
    const remote = parseSharedConfig({ llm: { provider: "openai", model: "", baseUrl: "" } });
    expect(preferLocalLlm(remote, local).llm).toEqual(local.llm);
  });

  it("accepts a remote provider that was actually set, even with a blank model", () => {
    const local = parseSharedConfig({ llm: { provider: "codex-cli", model: "", baseUrl: "" } });
    const remote = parseSharedConfig({ llm: { provider: "grok-cli", model: "", baseUrl: "" } });
    expect(preferLocalLlm(remote, local).llm.provider).toBe("grok-cli");
  });
});
