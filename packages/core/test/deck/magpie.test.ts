import { describe, expect, it } from "bun:test";

import { fetchMagpieModels, magpieRoute, toMagpieRouteModel } from "../../src/deck/dsh/magpie.js";
import { renderDshPatch } from "../../src/deck/dsh/patch.js";

describe("magpie gateway models", () => {
  it("maps a gateway entry onto the pi-ai model profile fields", () => {
    expect(
      toMagpieRouteModel({
        id: "auto/glm-5.3-flash",
        display_name: "GLM-5.3-Flash",
        magpie_label: "GLM-5.3-Flash · routing group",
        context_window: 1048576,
        context_length: 1048576,
        max_output_tokens: 393216,
        modalities: { input: ["text"], output: ["text"] },
        reasoning: true,
        reasoning_levels: ["low", "high", "max"],
      }),
    ).toEqual({
      id: "auto/glm-5.3-flash",
      name: "GLM-5.3-Flash · routing group",
      contextWindow: 1048576,
      maxTokens: 393216,
      input: ["text"],
      reasoningEfforts: { low: "low", high: "high", max: "max" },
    });
  });

  it("maps none to off, drops levels pi-ai does not know, and honours image input", () => {
    expect(
      toMagpieRouteModel({
        id: "auto/gpt-6-sol",
        reasoning: true,
        reasoning_levels: ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
        modalities: { input: ["text", "image"] },
      })?.reasoningEfforts,
    ).toEqual({ off: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
    expect(
      toMagpieRouteModel({ id: "m", modalities: { input: ["text", "image"] } })?.input,
    ).toEqual(["text", "image"]);
    expect(toMagpieRouteModel({ id: "m", reasoning: false })?.reasoningEfforts).toBe(false);
    // 只有认不出的档位时干脆不声明，pi-ai 按非推理模型处理。
    expect(toMagpieRouteModel({ id: "m", reasoning: true, reasoning_levels: ["ultra"] })).toEqual({ id: "m" });
  });

  it("falls back through name fields and ignores broken entries", () => {
    expect(toMagpieRouteModel({ id: "zhipu/glm-5.3", display_name: "GLM-5.3" })?.name).toBe("GLM-5.3");
    expect(toMagpieRouteModel({ id: "zhipu/glm-5.3" })?.name).toBeUndefined();
    expect(toMagpieRouteModel({ display_name: "no id" })).toBeNull();
    expect(toMagpieRouteModel(null)).toBeNull();
    expect(toMagpieRouteModel("model")).toBeNull();
    // 未知模态与非法数字不进入映射。
    expect(toMagpieRouteModel({ id: "m", modalities: { input: ["audio"] } })).toEqual({ id: "m" });
    expect(toMagpieRouteModel({ id: "m", context_window: -1, max_output_tokens: "big" })).toEqual({ id: "m" });
  });
});

describe("magpie route", () => {
  it("declares an openai-completions route with the model catalog and a credential reference", () => {
    const route = magpieRoute({
      baseUrl: "http://127.0.0.1:3425/v1",
      models: [{ id: "auto/glm-5.3-flash", name: "GLM-5.3-Flash" }],
    });
    expect(route).toEqual({
      displayName: "Magpie",
      api: "openai-completions",
      baseURL: "http://127.0.0.1:3425/v1",
      // pi-ai 没有凭据就拒绝发请求，所以引用恒在；值由 dsh 的环境变量给。
      apiKeyEnv: "MAGPIE_API_KEY",
      models: [{ id: "auto/glm-5.3-flash", name: "GLM-5.3-Flash" }],
    });
  });

  it("lands in the generated patch as one llm-pi-ai config beside signed-in providers", () => {
    const text = renderDshPatch({
      plugins: [],
      piAiProviders: {
        xai: {},
        magpie: magpieRoute({
          baseUrl: "http://127.0.0.1:3425/v1",
          models: [{ id: "auto/glm-5.3-flash", reasoningEfforts: { off: "none" } }],
        }),
      },
    });
    expect(text).toContain("- id: llm-pi-ai");
    expect(text).toContain('"magpie":{"displayName":"Magpie","api":"openai-completions"');
    expect(text).toContain('"reasoningEfforts":{"off":"none"}');
  });
});

describe("magpie models fetch", () => {
  it("lists models from the gateway, sending the key when given", async () => {
    let seenAuth = "none";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        seenAuth = request.headers.get("authorization") ?? "none";
        if (!new URL(request.url).pathname.endsWith("/models")) return new Response(null, { status: 404 });
        return Response.json({
          data: [
            { id: "auto/glm-5.3-flash", magpie_label: "GLM-5.3-Flash", reasoning: true, reasoning_levels: ["low", "max"] },
            { broken: true },
          ],
        });
      },
    });
    try {
      const models = await fetchMagpieModels({
        baseUrl: `http://127.0.0.1:${server.port}/v1/`,
        apiKey: "sk-magpie",
      });
      expect(seenAuth).toBe("Bearer sk-magpie");
      expect(models).toEqual([
        {
          id: "auto/glm-5.3-flash",
          name: "GLM-5.3-Flash",
          reasoningEfforts: { low: "low", max: "max" },
        },
      ]);
    } finally {
      await server.stop(true);
    }
  });

  it("asks without an auth header when no key is configured and fails loudly on errors", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        if (request.headers.get("authorization") !== null) return new Response(null, { status: 500 });
        return new Response("nope", { status: 503 });
      },
    });
    try {
      await expect(fetchMagpieModels({ baseUrl: `http://127.0.0.1:${server.port}/v1` })).rejects.toThrow("503");
    } finally {
      await server.stop(true);
    }
  });
});
