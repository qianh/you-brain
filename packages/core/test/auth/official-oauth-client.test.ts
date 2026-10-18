import { afterEach, describe, expect, it } from "bun:test";

import { GoogleOAuth, resolveOAuthClientConfig } from "../../src/auth/google-oauth.js";
import { MemorySecretStore } from "../../src/auth/secret-store.js";
import {
  BUNDLED_GOOGLE_OAUTH_CLIENT,
  MISSING_OFFICIAL_OAUTH_MESSAGE,
  OFFICIAL_OAUTH_CLIENT_ID_PLACEHOLDER,
  OFFICIAL_OAUTH_CLIENT_SECRET_PLACEHOLDER,
  isUsableOfficialOAuthClient,
  resolveOfficialOAuthClient,
} from "../../src/auth/official-oauth-client.js";

const ENV_KEYS = [
  "YOU_BRAIN_BUNDLED_OAUTH_CLIENT_ID",
  "YOU_BRAIN_BUNDLED_OAUTH_CLIENT_SECRET",
  "YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID",
  "YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET",
] as const;

const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

function isolateEnv(): void {
  for (const key of ENV_KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    delete process.env[key];
  }
}

const SAMPLE_ID = "sample.apps.googleusercontent.com";
const SAMPLE_SECRET = "sample-secret";

describe("official OAuth client", () => {
  it("keeps placeholders in source and rejects them", async () => {
    isolateEnv();
    const source = await Bun.file(new URL("../../src/auth/official-oauth-client.ts", import.meta.url)).text();
    expect(source).toContain("clientId: OFFICIAL_OAUTH_CLIENT_ID_PLACEHOLDER");
    expect(source).toContain("clientSecret: OFFICIAL_OAUTH_CLIENT_SECRET_PLACEHOLDER");
    expect(source).not.toMatch(/clientId:\s*"[^"]+\.apps\.googleusercontent\.com"/u);
    expect(BUNDLED_GOOGLE_OAUTH_CLIENT.clientId).toBe(OFFICIAL_OAUTH_CLIENT_ID_PLACEHOLDER);
    expect(BUNDLED_GOOGLE_OAUTH_CLIENT.clientSecret).toBe(OFFICIAL_OAUTH_CLIENT_SECRET_PLACEHOLDER);
    const resolved = resolveOfficialOAuthClient({});
    expect(isUsableOfficialOAuthClient(resolved)).toBe(false);
    await expect(resolveOAuthClientConfig({ mode: "official", env: {} })).rejects.toEqual(
      expect.objectContaining({
        code: "AUTH_REQUIRED",
        message: MISSING_OFFICIAL_OAUTH_MESSAGE,
      }),
    );
  });

  it("reads YOU_BRAIN_GOOGLE_* for a source run and prefers bundled values", async () => {
    isolateEnv();
    const fromEnv = resolveOfficialOAuthClient({
      YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID: `  ${SAMPLE_ID}  `,
      YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET: SAMPLE_SECRET,
    });
    expect(fromEnv).toEqual({
      clientId: SAMPLE_ID,
      clientSecret: SAMPLE_SECRET,
      redirectUris: ["http://127.0.0.1"],
    });
    expect(isUsableOfficialOAuthClient(fromEnv)).toBe(true);
    await expect(
      resolveOAuthClientConfig({
        mode: "official",
        env: {
          YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID: SAMPLE_ID,
          YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET: SAMPLE_SECRET,
        },
      }),
    ).resolves.toEqual(fromEnv);

    process.env.YOU_BRAIN_BUNDLED_OAUTH_CLIENT_ID = "bundled.apps.googleusercontent.com";
    process.env.YOU_BRAIN_BUNDLED_OAUTH_CLIENT_SECRET = "bundled-secret";
    const bundled = resolveOfficialOAuthClient({
      YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID: SAMPLE_ID,
      YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET: SAMPLE_SECRET,
    });
    expect(bundled.clientId).toBe("bundled.apps.googleusercontent.com");
    expect(bundled.clientSecret).toBe("bundled-secret");
  });

  it("ignores placeholder bundled values and falls back to the source environment", () => {
    isolateEnv();
    process.env.YOU_BRAIN_BUNDLED_OAUTH_CLIENT_ID = OFFICIAL_OAUTH_CLIENT_ID_PLACEHOLDER;
    process.env.YOU_BRAIN_BUNDLED_OAUTH_CLIENT_SECRET = OFFICIAL_OAUTH_CLIENT_SECRET_PLACEHOLDER;
    const resolved = resolveOfficialOAuthClient({
      YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID: SAMPLE_ID,
      YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET: SAMPLE_SECRET,
    });
    expect(resolved.clientId).toBe(SAMPLE_ID);
    expect(resolved.clientSecret).toBe(SAMPLE_SECRET);
  });

  it("puts the official client id and Drive scope on the authorization URL", async () => {
    isolateEnv();
    let seenUrl = "";
    const oauth = new GoogleOAuth(
      {
        mode: "official",
        env: {
          YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID: SAMPLE_ID,
          YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET: SAMPLE_SECRET,
        },
      },
      new MemorySecretStore(null),
      {
        createClient: (clientId, _clientSecret, redirectUri) => {
          const client = {
            generateCodeVerifierAsync: async () => ({
              codeVerifier: "verifier",
              codeChallenge: "challenge",
            }),
            generateAuthUrl: (options: { scope?: string | string[] }) => {
              const scope = Array.isArray(options.scope) ? options.scope.join(" ") : options.scope ?? "";
              const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
              url.searchParams.set("client_id", clientId);
              url.searchParams.set("redirect_uri", redirectUri ?? "");
              url.searchParams.set("scope", scope);
              return url.toString();
            },
            getToken: async () => ({ tokens: {} }),
            getAccessToken: async () => ({ token: "" }),
            setCredentials: () => undefined,
            on: () => client,
          };
          return client as never;
        },
        startLoopback: async () => ({
          redirectUri: "http://127.0.0.1:8765/oauth/callback",
          authorize: async (url: string) => {
            seenUrl = url;
            throw new Error("OAuth authorization was cancelled");
          },
          close: async () => undefined,
        }),
      },
    );
    await expect(oauth.getClient({ interactive: true })).rejects.toThrow(/cancelled/u);
    const url = new URL(seenUrl);
    expect(url.searchParams.get("client_id")).toBe(SAMPLE_ID);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8765/oauth/callback");
  });
});
