import { describe, expect, it } from "bun:test";

import {
  ANTHROPIC_JSON_TOOL,
  ANTHROPIC_VERSION,
  createAnthropicBackend,
} from "../../src/llm/anthropic.js";
import { LlmRequestError } from "../../src/llm/errors.js";
import { LLM_PRESETS } from "../../src/llm/presets.js";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: { title: { type: "string" } },
};

async function withServer(
  fetch: (request: Request) => Response | Promise<Response>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  try {
    await run(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.stop(true);
  }
}

describe("anthropic backend", () => {
  it("calls the Messages API and forces JSON through tool_use", async () => {
    let captured: { path: string; apiKey: string | null; version: string | null; body: Record<string, unknown> } | undefined;
    await withServer(async (request) => {
      captured = {
        path: new URL(request.url).pathname,
        apiKey: request.headers.get("x-api-key"),
        version: request.headers.get("anthropic-version"),
        body: (await request.json()) as Record<string, unknown>,
      };
      return Response.json({
        content: [
          { type: "text", text: "ignore" },
          { type: "tool_use", id: "toolu_1", name: ANTHROPIC_JSON_TOOL, input: { title: "命名" } },
        ],
      });
    }, async (baseUrl) => {
      const backend = createAnthropicBackend({
        preset: LLM_PRESETS.claude,
        model: "claude-sonnet-5-5",
        baseUrl,
        apiKey: "sk-ant",
      });
      expect(
        await backend.complete({ system: "提炼", user: "新增消息", jsonSchema: schema }),
      ).toBe("{\"title\":\"命名\"}");
    });

    expect(captured?.path).toBe("/v1/messages");
    expect(captured?.apiKey).toBe("sk-ant");
    expect(captured?.version).toBe(ANTHROPIC_VERSION);
    expect(captured?.body.model).toBe("claude-sonnet-5-5");
    expect(captured?.body.system).toContain("提炼");
    expect(captured?.body.messages).toEqual([{ role: "user", content: "新增消息" }]);
    expect(captured?.body.max_tokens).toBe(4096);
    const tools = captured?.body.tools as Array<Record<string, unknown>>;
    expect(tools[0]?.name).toBe(ANTHROPIC_JSON_TOOL);
    expect(tools[0]?.input_schema).toEqual(schema);
    expect(captured?.body.tool_choice).toEqual({ type: "tool", name: ANTHROPIC_JSON_TOOL });
  });

  it("returns text when no schema is requested", async () => {
    let tools: unknown;
    await withServer(async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      tools = body.tools;
      return Response.json({
        content: [{ type: "text", text: "ok" }],
      });
    }, async (baseUrl) => {
      const backend = createAnthropicBackend({
        preset: LLM_PRESETS.claude,
        model: "claude-sonnet-5-5",
        baseUrl,
        apiKey: "sk-ant",
      });
      expect(await backend.test()).toBeUndefined();
      expect(tools).toBeUndefined();
    });
  });

  it("classifies auth, rate limit, and server errors", async () => {
    const cases = [
      { status: 401, kind: "auth" },
      { status: 429, kind: "rate_limit" },
      { status: 529, kind: "server" },
    ] as const;
    for (const item of cases) {
      await withServer(
        () =>
          Response.json(
            { type: "error", error: { type: "api_error", message: "nope" } },
            { status: item.status },
          ),
        async (baseUrl) => {
          const backend = createAnthropicBackend({
            preset: LLM_PRESETS.claude,
            model: "claude-sonnet-5-5",
            baseUrl,
            apiKey: "sk-ant",
          });
          const error = await backend.complete({ system: "sys", user: "hi" }).then(
            () => {
              throw new Error("expected failure");
            },
            (caught: unknown) => caught,
          );
          expect(error).toBeInstanceOf(LlmRequestError);
          expect((error as LlmRequestError).kind).toBe(item.kind);
          expect((error as LlmRequestError).message).toContain("nope");
        },
      );
    }
  });

  it("classifies an exceeded timeout as a network error", async () => {
    await withServer(
      (request) =>
        new Promise<Response>((resolve) => {
          const finish = () => resolve(new Response("late"));
          if (request.signal.aborted) {
            finish();
            return;
          }
          request.signal.addEventListener("abort", finish, { once: true });
        }),
      async (baseUrl) => {
        const backend = createAnthropicBackend({
          preset: LLM_PRESETS.claude,
          model: "claude-sonnet-5-5",
          baseUrl,
          apiKey: "sk-ant",
          timeoutMs: 200,
        });
        const error = await backend.complete({ system: "sys", user: "hi" }).then(
          () => {
            throw new Error("expected failure");
          },
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(LlmRequestError);
        expect((error as LlmRequestError).kind).toBe("network");
        expect((error as LlmRequestError).message).toBe("请求超时");
      },
    );
  });
});
