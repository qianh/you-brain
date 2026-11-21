import { createDefaultSharedConfig, parseSharedConfig } from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import { keepLocalLlm, sharedWithoutLlm } from "../../src/daemon/local-state.js";

describe("各设备自己维护模型", () => {
  it("同步下来的 shared.json 不改本机模型，其余字段照取", () => {
    const local = parseSharedConfig({
      llm: { provider: "grok-cli", model: "grok-4.7-build-fast:xhigh", baseUrl: "" },
      consolidateLlm: { enabled: true, provider: "grok-cli", model: "grok-4.7-build-fast:xhigh", baseUrl: "" },
    });
    const remote = parseSharedConfig({
      llm: { provider: "magpie", model: "grok/grok-4.7-build-fast", baseUrl: "" },
      consolidateLlm: { enabled: false, provider: "magpie", model: "x", baseUrl: "" },
      refine: { ...createDefaultSharedConfig().refine, idleMinutes: 9 },
    });
    const merged = keepLocalLlm(remote, local);
    expect(merged.llm).toEqual(local.llm);
    expect(merged.consolidateLlm).toEqual(local.consolidateLlm);
    expect(merged.refine.idleMinutes).toBe(9);
  });

  it("本机还是默认模型时，也不接受 Drive 上别的设备选的模型", () => {
    const local = createDefaultSharedConfig();
    const remote = parseSharedConfig({ llm: { provider: "magpie", model: "grok/grok-4.7-build-fast", baseUrl: "" } });
    expect(keepLocalLlm(remote, local).llm).toEqual(local.llm);
  });

  it("推到 Drive 的补丁不带模型字段", () => {
    const patch = sharedWithoutLlm(createDefaultSharedConfig());
    expect("llm" in patch).toBe(false);
    expect("consolidateLlm" in patch).toBe(false);
    expect("refine" in patch).toBe(true);
  });
});
