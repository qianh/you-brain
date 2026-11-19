import { describe, expect, it } from "bun:test";

import { LlmAbortError, LlmRequestError } from "../../src/llm/errors.js";
import { createOpenAiCompatibleBackend } from "../../src/llm/openai-compatible.js";
import { LLM_PRESETS } from "../../src/llm/presets.js";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
};

async function withServer(
  fetch: (request: Request) => Response | Promise<Response>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  try {
    await run(`http://127.0.0.1:${server.port}/v1`);
  } finally {
    await server.stop(true);
  }
}

describe("openai-compatible backend", () => {
  it("posts chat completions and degrades response_format by provider", async () => {
    const seen: Array<{ path: string; authorization: string | null; body: Record<string, unknown> }> = [];
    await withServer(async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: (await request.json()) as Record<string, unknown>,
      });
      return Response.json({
        choices: [{ message: { content: "{\"ok\":true}" } }],
      });
    }, async (baseUrl) => {
      const openai = createOpenAiCompatibleBackend({
        preset: LLM_PRESETS.openai,
        model: "gpt-5.4",
        baseUrl,
        apiKey: "sk-openai",
      });
      const deepseek = createOpenAiCompatibleBackend({
        preset: LLM_PRESETS.deepseek,
        model: "deepseek-flash",
        baseUrl,
        apiKey: "sk-deepseek",
      });
      expect(await openai.complete({ system: "sys", user: "user", jsonSchema: schema })).toBe(
        "{\"ok\":true}",
      );
      expect(await deepseek.complete({ system: "sys", user: "user", jsonSchema: schema })).toBe(
        "{\"ok\":true}",
      );
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.path).toBe("/v1/chat/completions");
    expect(seen[0]?.authorization).toBe("Bearer sk-openai");
    expect(seen[0]?.body.model).toBe("gpt-5.4");
    const openaiMessages = seen[0]?.body.messages as Array<{ role: string; content: string }>;
    expect(openaiMessages[0]?.role).toBe("system");
    expect(openaiMessages[0]?.content).toContain("sys");
    expect(openaiMessages[0]?.content).toContain("\"ok\"");
    expect(openaiMessages[1]).toEqual({ role: "user", content: "user" });
    expect(seen[0]?.body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "response", strict: true, schema },
    });
    expect(seen[1]?.authorization).toBe("Bearer sk-deepseek");
    expect(seen[1]?.body.response_format).toEqual({ type: "json_object" });
  });

  it("omits the authorization header when there is no key", async () => {
    let authorization: string | null = "unset";
    await withServer(async (request) => {
      authorization = request.headers.get("authorization");
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    }, async (baseUrl) => {
      const backend = createOpenAiCompatibleBackend({
        preset: LLM_PRESETS.ollama,
        model: "llama3.2",
        baseUrl,
      });
      expect(await backend.complete({ system: "sys", user: "hi" })).toBe("ok");
    });
    expect(authorization).toBeNull();
  });

  it("reads array text content", async () => {
    await withServer(
      () =>
        Response.json({
          choices: [{ message: { content: [{ type: "text", text: "ping" }, { type: "text", text: "pong" }] } }],
        }),
      async (baseUrl) => {
        const backend = createOpenAiCompatibleBackend({
          preset: LLM_PRESETS.qwen,
          model: "qwen-plus",
          baseUrl,
          apiKey: "sk-qwen",
        });
        expect(await backend.complete({ system: "sys", user: "hi" })).toBe("pingpong");
      },
    );
  });

  it("classifies auth, rate limit, server, and client errors", async () => {
    const cases = [
      { status: 401, kind: "auth", text: "鉴权失败" },
      { status: 403, kind: "auth", text: "鉴权失败" },
      { status: 429, kind: "rate_limit", text: "请求被限流" },
      { status: 500, kind: "server", text: "模型服务错误" },
      { status: 400, kind: "client", text: "请求被拒绝" },
    ] as const;
    for (const item of cases) {
      await withServer(
        () => Response.json({ error: { message: "boom" } }, { status: item.status }),
        async (baseUrl) => {
          const backend = createOpenAiCompatibleBackend({
            preset: LLM_PRESETS.glm,
            model: "glm-5.3",
            baseUrl,
            apiKey: "sk-glm",
          });
          const error = await backend.complete({ system: "sys", user: "hi" }).then(
            () => {
              throw new Error("expected failure");
            },
            (caught: unknown) => caught,
          );
          expect(error).toBeInstanceOf(LlmRequestError);
          const typed = error as LlmRequestError;
          expect(typed.kind).toBe(item.kind);
          expect(typed.message).toContain(item.text);
          expect(typed.message).toContain("boom");
          expect(typed.status).toBe(item.status);
          expect(typed.retryable).toBe(item.kind === "rate_limit" || item.kind === "server");
        },
      );
    }
  });

  it("classifies a closed port as a network error", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });
    const baseUrl = `http://127.0.0.1:${server.port}/v1`;
    await server.stop(true);
    const backend = createOpenAiCompatibleBackend({
      preset: LLM_PRESETS.kimi,
      model: "kimi-k2.6",
      baseUrl,
      apiKey: "sk-kimi",
      timeoutMs: 1_000,
    });
    const error = await backend.complete({ system: "sys", user: "hi" }).then(
      () => {
        throw new Error("expected failure");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LlmRequestError);
    expect((error as LlmRequestError).kind).toBe("network");
    expect((error as LlmRequestError).retryable).toBe(true);
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
        const backend = createOpenAiCompatibleBackend({
          preset: LLM_PRESETS.openai,
          model: "gpt-5.4",
          baseUrl,
          apiKey: "sk-openai",
          timeoutMs: 200,
        });
        const error = await backend.complete({ system: "sys", user: "hi" }).then(
          () => {
            throw new Error("expected failure");
          },
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(LlmRequestError);
        const typed = error as LlmRequestError;
        expect(typed.kind).toBe("network");
        expect(typed.message).toBe("请求超时");
        expect(typed.retryable).toBe(true);
      },
    );
  });

  it("concatenates SSE chunks, ignores reasoning_content in output, and keeps idle timer alive", async () => {
    const seenBodies: Array<Record<string, unknown>> = [];
    const deltas: string[] = [];
    await withServer(
      async (request) => {
        seenBodies.push((await request.json()) as Record<string, unknown>);
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
            await new Promise((r) => setTimeout(r, 40));
            controller.enqueue(
              encoder.encode(
                `data:${JSON.stringify({ choices: [{ delta: { reasoning_content: "思考中" } }] })}\r\n\r\n`,
              ),
            );
            await new Promise((r) => setTimeout(r, 40));
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "{\"ok\":" } }] })}\n\n`,
              ),
            );
            await new Promise((r) => setTimeout(r, 40));
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "true}" }, finish_reason: "stop" }] })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      },
      async (baseUrl) => {
        const backend = createOpenAiCompatibleBackend({
          preset: LLM_PRESETS.magpie,
          model: "grok/grok-4.7-build-fast",
          baseUrl,
        });
        const text = await backend.completeStream!(
          {
            system: "sys",
            user: "hi",
            stream: true,
            timeoutMs: 2_000,
            firstChunkTimeoutMs: 500,
            idleTimeoutMs: 120,
          },
          (cumulative) => deltas.push(cumulative),
        );
        expect(text).toBe("{\"ok\":true}");
      },
    );
    expect(seenBodies[0]?.stream).toBe(true);
    expect(deltas).toEqual(["{\"ok\":", "{\"ok\":true}"]);
  });

  it("aborts with a retryable network error when SSE stream goes idle", async () => {
    await withServer(
      () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`),
            );
            // Intentionally never sends another chunk or closes.
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
      async (baseUrl) => {
        const backend = createOpenAiCompatibleBackend({
          preset: LLM_PRESETS.magpie,
          model: "grok/grok-4.7-build-fast",
          baseUrl,
        });
        const error = await backend
          .complete({
            system: "sys",
            user: "hi",
            stream: true,
            timeoutMs: 5_000,
            firstChunkTimeoutMs: 1_000,
            idleTimeoutMs: 100,
          })
          .then(
            () => {
              throw new Error("expected failure");
            },
            (caught: unknown) => caught,
          );
        expect(error).toBeInstanceOf(LlmRequestError);
        expect((error as LlmRequestError).kind).toBe("network");
        expect((error as LlmRequestError).retryable).toBe(true);
        expect((error as LlmRequestError).message).toContain("空闲超时");
      },
    );
  });

  it("rejects a truncated SSE stream with neither [DONE] nor finish_reason", async () => {
    await withServer(
      () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "{\"ok\":" } }] })}\n\n`),
            );
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
      async (baseUrl) => {
        const backend = createOpenAiCompatibleBackend({
          preset: LLM_PRESETS.magpie,
          model: "m",
          baseUrl,
        });
        const error = await backend
          .complete({ system: "sys", user: "hi", stream: true })
          .then(
            () => {
              throw new Error("expected failure");
            },
            (caught: unknown) => caught,
          );
        expect(error).toBeInstanceOf(LlmRequestError);
        expect((error as LlmRequestError).kind).toBe("network");
        expect((error as LlmRequestError).retryable).toBe(true);
      },
    );
  });

  it("throws a server error when an SSE frame carries an error payload", async () => {
    await withServer(
      () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ error: { message: "upstream died" } })}\n\n`),
            );
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
      async (baseUrl) => {
        const backend = createOpenAiCompatibleBackend({
          preset: LLM_PRESETS.magpie,
          model: "m",
          baseUrl,
        });
        const error = await backend
          .complete({ system: "sys", user: "hi", stream: true })
          .then(
            () => {
              throw new Error("expected failure");
            },
            (caught: unknown) => caught,
          );
        expect(error).toBeInstanceOf(LlmRequestError);
        expect((error as LlmRequestError).kind).toBe("server");
        expect((error as LlmRequestError).message).toContain("upstream died");
      },
    );
  });

  it("falls back smoothly on application/json response and omits stream when not requested", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await withServer(
      async (request) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return Response.json({ choices: [{ message: { content: "{\"ok\":true}" } }] });
      },
      async (baseUrl) => {
        const backend = createOpenAiCompatibleBackend({
          preset: LLM_PRESETS.magpie,
          model: "m",
          baseUrl,
        });
        expect(await backend.complete({ system: "sys", user: "hi", stream: true })).toBe("{\"ok\":true}");
        expect(await backend.complete({ system: "sys", user: "hi" })).toBe("{\"ok\":true}");
      },
    );
    expect(bodies[0]?.stream).toBe(true);
    expect(bodies[1]?.stream).toBeUndefined();
  });

  it("downgrades to non-streaming on HTTP 400 and remembers streamUnsupported on the backend instance", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await withServer(
      async (request) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        if (body.stream === true) {
          return Response.json({ error: { message: "stream not supported with response_format" } }, { status: 400 });
        }
        return Response.json({ choices: [{ message: { content: "{\"ok\":true}" } }] });
      },
      async (baseUrl) => {
        const backend = createOpenAiCompatibleBackend({
          preset: LLM_PRESETS.magpie,
          model: "m",
          baseUrl,
        });
        expect(await backend.complete({ system: "sys", user: "first", stream: true })).toBe("{\"ok\":true}");
        expect(await backend.complete({ system: "sys", user: "second", stream: true })).toBe("{\"ok\":true}");
      },
    );
    expect(bodies).toHaveLength(3);
    expect(bodies[0]?.stream).toBe(true);
    expect(bodies[1]?.stream).toBeUndefined();
    expect(bodies[2]?.stream).toBeUndefined();
  });

  it("throws LlmAbortError when cancelled by an external signal", async () => {
    const controller = new AbortController();
    await withServer(
      (request) =>
        new Promise<Response>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(new Response("aborted")), { once: true });
        }),
      async (baseUrl) => {
        const backend = createOpenAiCompatibleBackend({
          preset: LLM_PRESETS.magpie,
          model: "m",
          baseUrl,
          timeoutMs: 5_000,
        });
        setTimeout(() => controller.abort(), 30);
        const error = await backend
          .complete({ system: "sys", user: "hi", stream: true, signal: controller.signal })
          .then(
            () => {
              throw new Error("expected abort");
            },
            (caught: unknown) => caught,
          );
        expect(error).toBeInstanceOf(LlmAbortError);
      },
    );
  });
});
