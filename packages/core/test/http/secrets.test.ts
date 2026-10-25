import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDefaultRoles, createDefaultSharedConfig } from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import type { HttpDeps } from "../../src/http/deps.js";
import { startDaemonHttp, type DaemonHttpServer } from "../../src/http/server.js";
import type { LlmKeyPutBody, LlmTestBody } from "../../src/http/types.js";

const NOW = new Date("2026-10-18T03:00:00.000Z");
const API_KEY_VALUE = "sk-test-key-do-not-echo";

interface Recorded {
  llmKeys: LlmKeyPutBody[];
  llmTests: LlmTestBody[];
}

function deps(
  recorded: Recorded,
  overrides: Partial<Pick<HttpDeps, "writeLlmKey" | "testLlm">> = {},
): HttpDeps {
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  return {
    today: unused,
    topics: unused,
    topic: async () => null,
    todo: async () => null,
    portrait: async () => null,
    portraitSnapshots: async () => [],
    portraitCorrections: async () => [],
    search: unused,
    devices: async () => [],
    readRoles: async () => createDefaultRoles(),
    writeRoles: async () => undefined,
    readConfig: async () => createDefaultSharedConfig(),
    writeConfig: async () => undefined,
    status: unused,
    reminders: async () => ({ reminders: [] }),
    reminder: async () => null,
    reportActivity: async (at) => ({ at }),
    now: () => NOW,
    sync: async () => ({ started: false, at: NOW.toISOString() }),
    upload: unused,
    events: { emit() {} },
    writeLlmKey: async (body) => {
      recorded.llmKeys.push(body);
    },
    testLlm: async (body) => {
      recorded.llmTests.push(body);
      return { ok: true, message: "连接成功，模型有响应。" };
    },
    ...overrides,
  };
}

async function withServer(
  httpDeps: HttpDeps,
  run: (server: DaemonHttpServer) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "you-brain-secrets-http-"));
  const server = await startDaemonHttp({
    dataDir,
    deps: httpDeps,
    createId: () => "01J00000000000000000000000",
  });
  try {
    await run(server);
  } finally {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function api(server: DaemonHttpServer, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${server.token}`);
  return fetch(`${server.baseUrl}${path}`, { ...init, headers });
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function emptyRecord(): Recorded {
  return { llmKeys: [], llmTests: [] };
}

describe("secrets and LLM test HTTP", () => {
  it("PUT /api/secrets/llm stores the key and never echoes it", async () => {
    const recorded = emptyRecord();
    await withServer(deps(recorded), async (server) => {
      const response = await api(
        server,
        "/api/secrets/llm",
        jsonInit("PUT", { provider: "deepseek", apiKey: API_KEY_VALUE }),
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(API_KEY_VALUE);
      expect(JSON.parse(text)).toEqual({ stored: true, echoed: false, hasSecret: true });
    });
    expect(recorded.llmKeys).toEqual([{ provider: "deepseek", apiKey: API_KEY_VALUE }]);
  });

  it("PUT /api/secrets/llm rejects an unknown provider, a missing key, and a blank key with 400", async () => {
    const recorded = emptyRecord();
    await withServer(deps(recorded), async (server) => {
      const unknownProvider = await api(
        server,
        "/api/secrets/llm",
        jsonInit("PUT", { provider: "not-a-provider", apiKey: "x" }),
      );
      expect(unknownProvider.status).toBe(400);
      expect(((await unknownProvider.json()) as { error: { code: string } }).error.code).toBe(
        "INVALID_INPUT",
      );

      const missingKey = await api(server, "/api/secrets/llm", jsonInit("PUT", { provider: "deepseek" }));
      expect(missingKey.status).toBe(400);

      const blankKey = await api(
        server,
        "/api/secrets/llm",
        jsonInit("PUT", { provider: "deepseek", apiKey: "   " }),
      );
      expect(blankKey.status).toBe(400);
    });
    expect(recorded.llmKeys).toEqual([]);
  });

  it("PUT /api/secrets/llm returns 503 NOT_SUPPORTED when the daemon does not supply the port", async () => {
    const recorded = emptyRecord();
    const { writeLlmKey: _omit, ...withoutWrite } = deps(recorded);
    await withServer(withoutWrite, async (server) => {
      const response = await api(
        server,
        "/api/secrets/llm",
        jsonInit("PUT", { provider: "deepseek", apiKey: API_KEY_VALUE }),
      );
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "NOT_SUPPORTED",
      );
    });
  });

  it("POST /api/actions/llm-test returns the daemon result", async () => {
    const recorded = emptyRecord();
    await withServer(deps(recorded), async (server) => {
      const response = await api(
        server,
        "/api/actions/llm-test",
        jsonInit("POST", { provider: "ollama", model: "llama3.2", baseUrl: "" }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, message: "连接成功，模型有响应。" });
    });
    expect(recorded.llmTests).toEqual([{ provider: "ollama", model: "llama3.2", baseUrl: "" }]);
  });

  it("POST /api/actions/llm-test passes through ok:false when the daemon reports a missing key", async () => {
    // The missing-key check runs in the daemon. This only confirms the route forwards its result.
    const recorded = emptyRecord();
    const httpDeps = deps(recorded, {
      testLlm: async () => ({ ok: false, message: "钥匙串里还没有这个服务商的 API Key。" }),
    });
    await withServer(httpDeps, async (server) => {
      const response = await api(
        server,
        "/api/actions/llm-test",
        jsonInit("POST", { provider: "deepseek", model: "deepseek-flash", baseUrl: "" }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: false,
        message: "钥匙串里还没有这个服务商的 API Key。",
      });
    });
  });

  it("POST /api/actions/llm-test rejects an invalid body with 400 and does not call the daemon", async () => {
    const recorded = emptyRecord();
    await withServer(deps(recorded), async (server) => {
      const response = await api(
        server,
        "/api/actions/llm-test",
        jsonInit("POST", { provider: "deepseek", model: "deepseek-flash" }),
      );
      expect(response.status).toBe(400);
    });
    expect(recorded.llmTests).toEqual([]);
  });

  it("returns 405 with an allow header for the wrong method", async () => {
    const recorded = emptyRecord();
    await withServer(deps(recorded), async (server) => {
      const llm = await api(server, "/api/secrets/llm", { method: "GET" });
      expect(llm.status).toBe(405);
      expect(llm.headers.get("allow")).toBe("PUT");
      const llmTest = await api(server, "/api/actions/llm-test", { method: "GET" });
      expect(llmTest.status).toBe(405);
      expect(llmTest.headers.get("allow")).toBe("POST");
    });
  });
});
