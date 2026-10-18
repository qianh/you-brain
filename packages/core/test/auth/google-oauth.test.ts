import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { MemoryKeychain, MemorySecretStore } from "../../src/auth/secret-store.js";
import {
  GOOGLE_DRIVE_SCOPE,
  GoogleOAuth,
  ReloginRequiredError,
  TEST_MODE_REFRESH_TTL_MS,
  googleAuthorizationOptions,
  parseOAuthClientConfig,
  readOAuthClientConfig,
  revokeGoogleCredential,
} from "../../src/auth/google-oauth.js";
import { createOAuthClientSecretStore } from "../../src/auth/secret-store-factory.js";
import { saveUserOAuthCredentials } from "../../src/auth/user-oauth.js";
import { createDefaultLocalConfig } from "../../src/domain/config.js";
import { writeLocalConfig } from "../../src/domain/config-io.js";

async function oauthClientFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "you-brain-oauth-"));
  const path = join(directory, "client.json");
  await writeFile(
    path,
    JSON.stringify({
      installed: {
        client_id: "client-id",
        client_secret: "client-secret",
        redirect_uris: ["http://127.0.0.1"],
      },
    }),
  );
  return path;
}

function fakeOAuthClient() {
  const client = new EventEmitter() as EventEmitter & {
    credentials: Record<string, unknown>;
    generateCodeVerifierAsync: () => Promise<{
      codeVerifier: string;
      codeChallenge: string;
    }>;
    generateAuthUrl: (options: Record<string, unknown>) => string;
    getToken: (options: Record<string, unknown>) => Promise<{
      tokens: Record<string, unknown>;
    }>;
    getAccessToken: () => Promise<unknown>;
    setCredentials: (tokens: Record<string, unknown>) => void;
  };
  client.credentials = {};
  client.generateCodeVerifierAsync = async () => ({
    codeVerifier: "fixed-verifier",
    codeChallenge: "fixed-challenge",
  });
  client.generateAuthUrl = () => "https://accounts.example/authorize";
  client.getToken = async () => ({
    tokens: { refresh_token: "new-refresh", access_token: "new-access" },
  });
  client.getAccessToken = async () => ({ token: "access" });
  client.setCredentials = (tokens) => {
    client.credentials = tokens;
  };
  return client;
}

describe("Google OAuth", () => {
  it("requests the full Drive scope", () => {
    expect(GOOGLE_DRIVE_SCOPE).toBe("https://www.googleapis.com/auth/drive");
    expect(googleAuthorizationOptions("state-1", "challenge-1").scope).toEqual([
      GOOGLE_DRIVE_SCOPE,
    ]);
  });

  it("parses an installed client file and rejects an incomplete one", () => {
    expect(
      parseOAuthClientConfig({
        installed: {
          client_id: "id",
          client_secret: "secret",
          redirect_uris: ["http://127.0.0.1/callback"],
        },
      }),
    ).toMatchObject({ clientId: "id", clientSecret: "secret" });
    expect(() => parseOAuthClientConfig({ web: { client_id: "id" } })).toThrow(
      /incomplete/,
    );
  });

  it("uses a bundled official client and rejects placeholders", async () => {
    await expect(
      readOAuthClientConfig("", {
        clientId: "official.apps.googleusercontent.com",
        clientSecret: "official-secret",
        redirectUris: ["http://127.0.0.1"],
      }),
    ).resolves.toEqual({
      clientId: "official.apps.googleusercontent.com",
      clientSecret: "official-secret",
      redirectUris: ["http://127.0.0.1"],
    });
    await expect(readOAuthClientConfig("")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("stores a refresh token with obtained_at and can roll it back", async () => {
    const secrets = new MemorySecretStore("old-credential");
    const client = fakeOAuthClient();
    const now = Date.parse("2026-03-01T00:00:00.000Z");
    const oauth = new GoogleOAuth(await oauthClientFile(), secrets, {
      createClient: () => client as never,
      now: () => now,
      startLoopback: async () => ({
        redirectUri: "http://127.0.0.1:9/oauth/callback",
        authorize: async () => "authorization-code",
        close: async () => undefined,
      }),
    });
    const staged = await oauth.beginInteractiveAuthorization();
    expect(await secrets.get()).toBe("old-credential");
    await staged.commit();
    const stored = JSON.parse((await secrets.get()) ?? "{}") as {
      refresh_token?: string;
      obtained_at?: string;
    };
    expect(stored.refresh_token).toBe("new-refresh");
    expect(stored.obtained_at).toBe(new Date(now).toISOString());
    await staged.rollback();
    expect(await secrets.get()).toBe("old-credential");
  });

  it("asks for a new login on invalid_grant without an interactive session", async () => {
    const secrets = new MemorySecretStore(
      JSON.stringify({ refresh_token: "expired", obtained_at: "2026-03-01T00:00:00.000Z" }),
    );
    let loopback = 0;
    const client = fakeOAuthClient();
    client.getAccessToken = async () => {
      const error = new Error("invalid_grant") as Error & {
        response: { data: { error: string } };
      };
      error.response = { data: { error: "invalid_grant" } };
      throw error;
    };
    const oauth = new GoogleOAuth(await oauthClientFile(), secrets, {
      createClient: () => client as never,
      startLoopback: async () => {
        loopback += 1;
        return {
          redirectUri: "http://127.0.0.1:9/oauth/callback",
          authorize: async () => "code",
          close: async () => undefined,
        };
      },
    });
    await expect(oauth.getClient({ interactive: false })).rejects.toBeInstanceOf(
      ReloginRequiredError,
    );
    await expect(oauth.getClient({ interactive: false })).rejects.toThrow("需要重新登录");
    expect(loopback).toBe(0);
  });

  it("refuses an official token that is already 7 days old", async () => {
    const obtained = Date.parse("2026-03-01T00:00:00.000Z");
    const secrets = new MemorySecretStore(
      JSON.stringify({
        refresh_token: "old",
        obtained_at: new Date(obtained).toISOString(),
      }),
    );
    let accessCalls = 0;
    const client = fakeOAuthClient();
    client.getAccessToken = async () => {
      accessCalls += 1;
      return { token: "nope" };
    };
    const oauth = new GoogleOAuth(await oauthClientFile(), secrets, {
      createClient: () => client as never,
      now: () => obtained + TEST_MODE_REFRESH_TTL_MS,
      startLoopback: async () => {
        throw new Error("must not open a browser");
      },
    });
    await expect(oauth.getClient({ interactive: false })).rejects.toThrow("需要重新登录");
    expect(accessCalls).toBe(0);
  });

  it("uses a user-supplied client id and a keychain client secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "you-brain-user-oauth-"));
    const configFile = join(directory, "config.toml");
    const memory = new MemoryKeychain();
    const secretStore = createOAuthClientSecretStore({
      platform: "darwin",
      configFile,
      memory,
    });
    const config = await saveUserOAuthCredentials({
      config: createDefaultLocalConfig({ hostname: "host", dataDir: directory }),
      clientId: "mine.apps.googleusercontent.com",
      clientSecret: "super-secret-value",
      secrets: secretStore,
    });
    await writeLocalConfig(configFile, config);
    const written = await readFile(configFile, "utf8");
    expect(written).toContain("mine.apps.googleusercontent.com");
    expect(written).not.toContain("super-secret-value");
    expect(config.oauth).toEqual({
      mode: "custom",
      clientId: "mine.apps.googleusercontent.com",
    });

    let seen: { id?: string; secret?: string } = {};
    const oauth = new GoogleOAuth(
      {
        mode: "custom",
        clientId: config.oauth.clientId,
        clientSecretStore: secretStore,
      },
      new MemorySecretStore(null),
      {
        createClient: (id, secret) => {
          seen = { id, secret };
          return fakeOAuthClient() as never;
        },
        startLoopback: async () => ({
          redirectUri: "http://127.0.0.1:9/oauth/callback",
          authorize: async () => "code",
          close: async () => undefined,
        }),
      },
    );
    await oauth.getClient({ interactive: true });
    expect(seen).toEqual({
      id: "mine.apps.googleusercontent.com",
      secret: "super-secret-value",
    });
  });

  it("revokes the stored refresh token", async () => {
    let body = "";
    const revoked = await revokeGoogleCredential(
      JSON.stringify({ refresh_token: "refresh-token", access_token: "access" }),
      (async (_url, init) => {
        body = String(init?.body ?? "");
        return { ok: true } as Response;
      }) as typeof fetch,
    );
    expect(revoked).toBe(true);
    expect(body).toContain("token=refresh-token");
    await expect(revokeGoogleCredential("not-json")).resolves.toBe(false);
  });
});
