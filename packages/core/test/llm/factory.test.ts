import { describe, expect, it } from "bun:test";

import { createLlmBackend, resolveLlmTarget } from "../../src/llm/factory.js";
import { LlmRequestError } from "../../src/llm/errors.js";

describe("llm factory", () => {
  it("fills empty model and baseUrl from the preset", () => {
    expect(resolveLlmTarget({ provider: "deepseek", model: "", baseUrl: "" })).toMatchObject({
      model: "deepseek-flash",
      baseUrl: "https://api.deepseek.com",
    });
    expect(resolveLlmTarget({ provider: "claude", model: "claude-haiku-5-5", baseUrl: "" })).toMatchObject({
      model: "claude-haiku-5-5",
      baseUrl: "https://api.anthropic.com",
    });
    expect(
      resolveLlmTarget({
        provider: "custom",
        model: "local",
        baseUrl: "http://127.0.0.1:8000/v1/",
      }),
    ).toMatchObject({ model: "local", baseUrl: "http://127.0.0.1:8000/v1" });
  });

  it("rejects a custom provider without a model or address", () => {
    expect(() => resolveLlmTarget({ provider: "custom", model: "", baseUrl: "" })).toThrow(
      LlmRequestError,
    );
    expect(() =>
      resolveLlmTarget({ provider: "custom", model: "local", baseUrl: "" }),
    ).toThrow("未配置模型地址");
    expect(() =>
      resolveLlmTarget({ provider: "custom", model: "  ", baseUrl: "http://127.0.0.1:8000/v1" }),
    ).toThrow("未配置模型名");
  });

  it("reads the key from the injected getter and skips it for ollama", async () => {
    const calls: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as { model?: string };
        if (new URL(request.url).pathname.endsWith("/messages")) {
          return Response.json({ content: [{ type: "text", text: body.model ?? "" }] });
        }
        return Response.json({
          choices: [{ message: { content: `${request.headers.get("authorization") ?? "none"}:${body.model}` } }],
        });
      },
    });
    try {
      const baseUrl = `http://127.0.0.1:${server.port}/v1`;
      const origin = `http://127.0.0.1:${server.port}`;
      const deepseek = await createLlmBackend({
        config: { provider: "deepseek", model: "", baseUrl },
        getApiKey: (provider) => {
          calls.push(provider);
          return "sk-from-keychain";
        },
      });
      expect(deepseek.id).toBe("deepseek");
      expect(deepseek.descriptor).toMatchObject({
        model: "deepseek-flash",
        kind: "openai-compatible",
        requiresApiKey: true,
      });
      expect(await deepseek.complete({ system: "s", user: "u" })).toBe(
        "Bearer sk-from-keychain:deepseek-flash",
      );

      const claude = await createLlmBackend({
        config: { provider: "claude", model: "", baseUrl: origin },
        getApiKey: (provider) => {
          calls.push(provider);
          return "sk-ant";
        },
      });
      expect(claude.descriptor.kind).toBe("anthropic");
      expect(claude.descriptor.model).toBe("claude-sonnet-5-5");
      expect(await claude.complete({ system: "s", user: "u" })).toBe("claude-sonnet-5-5");

      const ollama = await createLlmBackend({
        config: { provider: "ollama", model: "llama3.2", baseUrl },
        getApiKey: (provider) => {
          calls.push(provider);
          return "should-not-be-asked";
        },
      });
      expect(await ollama.complete({ system: "s", user: "u" })).toBe("none:llama3.2");
      expect(calls).toEqual(["deepseek", "claude"]);
    } finally {
      await server.stop(true);
    }
  });

  it("fails closed when the keychain has no key", async () => {
    const error = await createLlmBackend({
      config: { provider: "qwen", model: "", baseUrl: "" },
      getApiKey: async () => "  ",
    }).then(
      () => {
        throw new Error("expected failure");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LlmRequestError);
    expect((error as LlmRequestError).kind).toBe("auth");
    expect((error as LlmRequestError).message).toContain("you-brain/llm/qwen");
    expect((error as LlmRequestError).retryable).toBe(false);
  });
});
