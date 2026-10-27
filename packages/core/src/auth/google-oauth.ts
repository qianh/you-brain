import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { google } from "googleapis";

import type { OauthMode } from "../domain/config.js";
import { YouBrainError } from "../domain/errors.js";
import {
  BUNDLED_GOOGLE_OAUTH_CLIENT,
  MISSING_OFFICIAL_OAUTH_MESSAGE,
  isUsableOfficialOAuthClient,
  resolveOfficialOAuthClient,
} from "./official-oauth-client.js";
import {
  startHeadlessOAuthLoopback,
} from "./headless-oauth.js";
import {
  startOAuthLoopback,
  type OAuthLoopbackSession,
} from "./oauth-loopback.js";
import type { SecretStore } from "./secret-store.js";

export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

/** Official test-mode refresh tokens stop working after 7 days. */
export const TEST_MODE_REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const RELOGIN_REQUIRED_MESSAGE = "需要重新登录";

export type GoogleOAuthClient = InstanceType<typeof google.auth.OAuth2>;
type GoogleCredentials = Parameters<GoogleOAuthClient["setCredentials"]>[0];
type GoogleAuthorizationOptions = NonNullable<
  Parameters<GoogleOAuthClient["generateAuthUrl"]>[0]
>;

export type StoredGoogleCredentials = GoogleCredentials & {
  obtained_at?: string;
};

export class ReloginRequiredError extends YouBrainError {
  readonly reason = "relogin_required" as const;

  constructor() {
    super("AUTH_REQUIRED", RELOGIN_REQUIRED_MESSAGE);
    this.name = "ReloginRequiredError";
  }
}

export interface StagedGoogleAuthorization {
  client: GoogleOAuthClient;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface GoogleOAuthDependencies {
  createClient?: (
    clientId: string,
    clientSecret: string,
    redirectUri?: string,
  ) => GoogleOAuthClient;
  startLoopback?: (
    state: string,
    options: { signal?: AbortSignal },
  ) => Promise<OAuthLoopbackSession>;
  now?: () => number;
}

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

export interface GoogleOAuthOptions {
  mode?: OauthMode;
  clientFile?: string;
  clientId?: string;
  clientSecret?: string | null;
  clientSecretStore?: SecretStore;
  /**
   * 无界面机器：固定回调端口，先打印 SSH 隧道命令，不尝试拉起浏览器。
   * 端口被占用时直接报错，不会回退到随机端口。
   */
  headless?: { port?: number; describeTunnel?: (port: number) => string | null };
  /** Overrides process.env for YOU_BRAIN_GOOGLE_* when resolving the official client. */
  env?: NodeJS.ProcessEnv;
}

export function parseOAuthClientConfig(value: unknown): OAuthClientConfig {
  const root =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const candidate = (root.installed ?? root.web) as
    | Record<string, unknown>
    | undefined;
  const clientId = candidate?.client_id;
  const clientSecret = candidate?.client_secret;
  const redirectUris = candidate?.redirect_uris;
  if (
    typeof clientId !== "string" ||
    typeof clientSecret !== "string" ||
    !Array.isArray(redirectUris) ||
    !redirectUris.every((uri) => typeof uri === "string")
  ) {
    throw new Error("OAuth client file is incomplete");
  }
  return { clientId, clientSecret, redirectUris };
}

export function googleAuthorizationOptions(
  state: string,
  codeChallenge: string,
): GoogleAuthorizationOptions {
  return {
    access_type: "offline",
    prompt: "select_account consent",
    scope: [GOOGLE_DRIVE_SCOPE],
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256" as NonNullable<
      GoogleAuthorizationOptions["code_challenge_method"]
    >,
  };
}

export function isInvalidGrant(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return error instanceof Error && error.message.includes("invalid_grant");
  }
  const record = error as {
    message?: unknown;
    error?: unknown;
    cause?: unknown;
    response?: { data?: unknown };
  };
  if (record.error === "invalid_grant") return true;
  const data = record.response?.data;
  if (data && typeof data === "object" && "error" in data) {
    if ((data as { error?: unknown }).error === "invalid_grant") return true;
  }
  if (typeof data === "string" && data.includes("invalid_grant")) return true;
  if (typeof record.message === "string" && record.message.includes("invalid_grant")) {
    return true;
  }
  if (record.cause && record.cause !== error) return isInvalidGrant(record.cause);
  return false;
}

export function refreshTokenNeedsRelogin(
  serialized: string,
  mode: OauthMode,
  now = Date.now(),
): boolean {
  if (mode !== "official") return false;
  let parsed: { obtained_at?: unknown };
  try {
    parsed = JSON.parse(serialized) as { obtained_at?: unknown };
  } catch {
    return false;
  }
  if (typeof parsed.obtained_at !== "string") return false;
  const obtained = Date.parse(parsed.obtained_at);
  if (Number.isNaN(obtained)) return false;
  return now - obtained >= TEST_MODE_REFRESH_TTL_MS;
}

export async function readOAuthClientConfig(
  path: string,
  bundled: OAuthClientConfig = BUNDLED_GOOGLE_OAUTH_CLIENT,
): Promise<OAuthClientConfig> {
  if (!path) {
    if (isUsableOfficialOAuthClient(bundled) && bundled.redirectUris.length > 0) {
      return bundled;
    }
    throw new YouBrainError("AUTH_REQUIRED", MISSING_OFFICIAL_OAUTH_MESSAGE);
  }
  try {
    return parseOAuthClientConfig(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof YouBrainError) throw error;
    throw new YouBrainError(
      "AUTH_REQUIRED",
      "Unable to read a valid Google OAuth client file",
    );
  }
}

export async function resolveOAuthClientConfig(
  source: GoogleOAuthOptions,
): Promise<OAuthClientConfig> {
  const mode = source.mode ?? "official";
  if (mode === "custom") {
    const clientId = source.clientId?.trim() ?? "";
    let clientSecret = source.clientSecret ?? null;
    if (!clientSecret && source.clientSecretStore) {
      clientSecret = await source.clientSecretStore.get();
    }
    if (!clientId || !clientSecret?.trim()) {
      throw new YouBrainError("AUTH_REQUIRED", "自定义 OAuth 凭据不完整");
    }
    return {
      clientId,
      clientSecret: clientSecret.trim(),
      redirectUris: ["http://127.0.0.1"],
    };
  }
  if (source.clientFile) return readOAuthClientConfig(source.clientFile);
  const resolved = resolveOfficialOAuthClient(source.env ?? process.env);
  if (!isUsableOfficialOAuthClient(resolved)) {
    throw new YouBrainError("AUTH_REQUIRED", MISSING_OFFICIAL_OAUTH_MESSAGE);
  }
  return resolved;
}

export async function revokeGoogleCredential(
  serialized: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  let credentials: { refresh_token?: unknown; access_token?: unknown };
  try {
    credentials = JSON.parse(serialized) as typeof credentials;
  } catch {
    return false;
  }
  const token =
    typeof credentials.refresh_token === "string"
      ? credentials.refresh_token
      : typeof credentials.access_token === "string"
        ? credentials.access_token
        : null;
  if (!token) return false;
  const response = await fetcher("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  if (!response.ok) {
    throw new Error(`Google OAuth revocation failed with ${response.status}`);
  }
  return true;
}

function stampCredentials(
  tokens: StoredGoogleCredentials,
  previous: StoredGoogleCredentials | null,
  now: number,
): StoredGoogleCredentials {
  const refreshChanged =
    typeof tokens.refresh_token === "string" &&
    tokens.refresh_token !== previous?.refresh_token;
  const obtained =
    !refreshChanged && typeof previous?.obtained_at === "string"
      ? previous.obtained_at
      : new Date(now).toISOString();
  return { ...tokens, obtained_at: obtained };
}

export class GoogleOAuth {
  readonly #source: GoogleOAuthOptions;
  readonly #createClient: NonNullable<GoogleOAuthDependencies["createClient"]>;
  readonly #startLoopback: NonNullable<GoogleOAuthDependencies["startLoopback"]>;
  readonly #now: () => number;

  constructor(
    source: string | GoogleOAuthOptions,
    readonly secrets: SecretStore,
    dependencies: GoogleOAuthDependencies = {},
  ) {
    this.#source = typeof source === "string" ? { mode: "official", clientFile: source } : source;
    this.#createClient =
      dependencies.createClient ??
      ((clientId, clientSecret, redirectUri) =>
        new google.auth.OAuth2(clientId, clientSecret, redirectUri));
    this.#startLoopback = dependencies.startLoopback ?? startOAuthLoopback;
    this.#now = dependencies.now ?? Date.now;
  }

  mode(): OauthMode {
    return this.#source.mode ?? "official";
  }

  async getClient(options: {
    interactive: boolean;
    signal?: AbortSignal;
  }): Promise<GoogleOAuthClient> {
    const config = await resolveOAuthClientConfig(this.#source);
    const stored = await this.secrets.get();
    if (!stored) {
      if (!options.interactive) {
        throw new YouBrainError("AUTH_REQUIRED", "Google Drive authentication is required");
      }
      const staged = await this.#authorizeInteractive(config, null, options.signal);
      await staged.commit();
      return staged.client;
    }
    if (refreshTokenNeedsRelogin(stored, this.mode(), this.#now())) {
      if (!options.interactive) throw new ReloginRequiredError();
      const staged = await this.#authorizeInteractive(config, stored, options.signal);
      await staged.commit();
      return staged.client;
    }

    const client = this.#createClient(config.clientId, config.clientSecret);
    let credentials: StoredGoogleCredentials;
    try {
      credentials = JSON.parse(stored) as StoredGoogleCredentials;
      if (!credentials.refresh_token) throw new Error("refresh token missing");
    } catch (error) {
      if (!options.interactive) {
        throw new YouBrainError("AUTH_REQUIRED", "Stored Google authentication is invalid");
      }
      const staged = await this.#authorizeInteractive(config, stored, options.signal);
      await staged.commit();
      return staged.client;
    }
    client.setCredentials(credentials);
    this.#persistNewTokens(client, credentials);
    try {
      await client.getAccessToken();
      return client;
    } catch (error) {
      if (isInvalidGrant(error)) {
        if (!options.interactive) throw new ReloginRequiredError();
      } else if (!options.interactive) {
        throw new YouBrainError("AUTH_REQUIRED", "Stored Google authentication is invalid");
      }
      const staged = await this.#authorizeInteractive(config, stored, options.signal);
      await staged.commit();
      return staged.client;
    }
  }

  #persistNewTokens(client: GoogleOAuthClient, base: StoredGoogleCredentials): void {
    client.on("tokens", (tokens) => {
      const stamped = stampCredentials(
        { ...base, ...tokens },
        base,
        this.#now(),
      );
      void this.secrets.set(JSON.stringify(stamped)).catch(() => undefined);
    });
  }

  async beginInteractiveAuthorization(): Promise<StagedGoogleAuthorization> {
    const config = await resolveOAuthClientConfig(this.#source);
    const previousCredential = await this.secrets.get();
    return this.#authorizeInteractive(config, previousCredential);
  }

  async #authorizeInteractive(
    config: OAuthClientConfig,
    previousCredential: string | null,
    signal?: AbortSignal,
  ): Promise<StagedGoogleAuthorization> {
    await this.secrets.probe?.();
    let previousParsed: StoredGoogleCredentials | null = null;
    if (previousCredential) {
      try {
        previousParsed = JSON.parse(previousCredential) as StoredGoogleCredentials;
      } catch {
        previousParsed = null;
      }
    }
    const state = randomBytes(24).toString("hex");
    const loopback = await (this.#source.headless
      ? startHeadlessOAuthLoopback(state, {
          ...(signal ? { signal } : {}),
          ...(this.#source.headless.port === undefined
            ? {}
            : { port: this.#source.headless.port }),
          ...(this.#source.headless.describeTunnel
            ? { describeTunnel: this.#source.headless.describeTunnel }
            : {}),
        })
      : this.#startLoopback(state, signal ? { signal } : {}));
    const client = this.#createClient(
      config.clientId,
      config.clientSecret,
      loopback.redirectUri,
    );
    try {
      const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
      if (!codeChallenge) throw new Error("Unable to generate PKCE challenge");
      const authorizationUrl = client.generateAuthUrl(
        googleAuthorizationOptions(state, codeChallenge),
      );
      const code = await loopback.authorize(authorizationUrl);
      const { tokens } = await client.getToken({ code, codeVerifier });
      if (!tokens.refresh_token) throw new Error("Google did not return a refresh token");
      const stamped = stampCredentials(tokens, previousParsed, this.#now());
      client.setCredentials(stamped);
      let pending: StoredGoogleCredentials = stamped;
      let active = true;
      let committed = false;
      let commitAttempted = false;
      client.on("tokens", (newTokens) => {
        pending = stampCredentials({ ...pending, ...newTokens }, pending, this.#now());
        if (active && committed) {
          void this.secrets.set(JSON.stringify(pending)).catch(() => undefined);
        }
      });
      return {
        client,
        commit: async () => {
          if (!active) throw new Error("OAuth authorization was rolled back");
          if (committed) return;
          commitAttempted = true;
          const serialized = JSON.stringify(pending);
          await this.secrets.set(serialized);
          committed = true;
          const latest = JSON.stringify(pending);
          if (latest !== serialized) await this.secrets.set(latest);
        },
        rollback: async () => {
          if (!active) return;
          active = false;
          if (!commitAttempted && !committed) return;
          if (previousCredential) await this.secrets.set(previousCredential);
          else await this.secrets.delete();
        },
      };
    } finally {
      await loopback.close();
    }
  }
}
