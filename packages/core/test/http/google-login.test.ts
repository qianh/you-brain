import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDefaultRoles, createDefaultSharedConfig } from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import type { HttpDeps } from "../../src/http/deps.js";
import { HttpError } from "../../src/http/handlers.js";
import { startDaemonHttp, type DaemonHttpServer } from "../../src/http/server.js";
import type { GoogleLoginResult } from "../../src/http/types.js";

const NOW = new Date("2026-10-18T03:00:00.000Z");

function deps(
  googleLogin?: () => Promise<GoogleLoginResult>,
  extra: Pick<HttpDeps, "googleLogout" | "googleSwitch"> = {},
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
    ...(googleLogin ? { googleLogin } : {}),
    ...extra,
  };
}

async function withServer(
  httpDeps: HttpDeps,
  run: (server: DaemonHttpServer) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "you-brain-google-login-http-"));
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

describe("google login HTTP", () => {
  it("POST /api/actions/google-login returns the daemon message as is", async () => {
    await withServer(
      deps(async () => ({ ok: true, message: "已使用 john@example.com 登录" })),
      async (server) => {
        const response = await api(server, "/api/actions/google-login", { method: "POST" });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, message: "已使用 john@example.com 登录" });
      },
    );
  });

  it("passes a recoverable login failure through with its code and Chinese message", async () => {
    await withServer(
      deps(async () => {
        throw new HttpError(409, "AUTH_REQUIRED", "Google 登录已取消");
      }),
      async (server) => {
        const response = await api(server, "/api/actions/google-login", { method: "POST" });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: { code: "AUTH_REQUIRED", message: "Google 登录已取消" },
        });
      },
    );
  });

  it("answers 405 with an Allow header for other methods", async () => {
    await withServer(deps(async () => ({ ok: true, message: "已登录" })), async (server) => {
      const response = await api(server, "/api/actions/google-login");
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    });
  });

  it("answers 503 NOT_SUPPORTED when the daemon does not supply the dependency", async () => {
    await withServer(deps(), async (server) => {
      const response = await api(server, "/api/actions/google-login", { method: "POST" });
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "NOT_SUPPORTED",
      );
    });
  });
});

describe("google logout and switch HTTP", () => {
  for (const route of ["google-logout", "google-switch"] as const) {
    const key = route === "google-logout" ? "googleLogout" : "googleSwitch";

    it(`POST /api/actions/${route} returns the daemon message as is`, async () => {
      await withServer(
        deps(undefined, { [key]: async () => ({ ok: true, message: "已退出" }) }),
        async (server) => {
          const response = await api(server, `/api/actions/${route}`, { method: "POST" });
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ ok: true, message: "已退出" });
        },
      );
    });

    it(`/api/actions/${route} answers 405 for GET and 503 when unsupported`, async () => {
      await withServer(deps(), async (server) => {
        const wrong = await api(server, `/api/actions/${route}`);
        expect(wrong.status).toBe(405);
        expect(wrong.headers.get("allow")).toBe("POST");
        const missing = await api(server, `/api/actions/${route}`, { method: "POST" });
        expect(missing.status).toBe(503);
      });
    });
  }

  it("passes a refusal through with its code", async () => {
    await withServer(
      deps(undefined, {
        googleLogout: async () => {
          throw new HttpError(409, "LOGIN_IN_PROGRESS", "登录进行中");
        },
      }),
      async (server) => {
        const response = await api(server, "/api/actions/google-logout", { method: "POST" });
        expect(response.status).toBe(409);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
          "LOGIN_IN_PROGRESS",
        );
      },
    );
  });
});
