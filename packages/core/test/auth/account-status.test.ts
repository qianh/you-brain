import { describe, expect, it } from "bun:test";

import {
  RELOGIN_REQUIRED_MESSAGE,
  TEST_MODE_REFRESH_TTL_MS,
} from "../../src/auth/google-oauth.js";
import {
  resolveGoogleAccountStatus,
  resolveReusableGoogleAccount,
} from "../../src/auth/account-status.js";
import { createDefaultLocalConfig } from "../../src/domain/config.js";

function config() {
  return createDefaultLocalConfig({
    hostname: "test-device",
    dataDir: "/tmp/you-brain",
  });
}

describe("Google account status", () => {
  it("reports a missing credential without calling Google", async () => {
    let calls = 0;
    const result = await resolveGoogleAccountStatus({
      config: config(),
      credential: null,
      loadAccount: async () => {
        calls += 1;
        throw new Error("must not validate");
      },
    });
    expect(result).toEqual({
      authenticated: false,
      reason: "missing_credential",
      drive: { configured: false, rootFolderName: "brain-hub" },
    });
    expect(calls).toBe(0);
  });

  it("reports an invalid credential without leaking the token", async () => {
    const connected = config();
    connected.driveRootId = "root-1";
    connected.account = {
      email: "configured@example.com",
      displayName: "Configured",
      permissionId: "permission-1",
    };
    const result = await resolveGoogleAccountStatus({
      config: connected,
      credential: "sensitive-token",
      loadAccount: async () => {
        throw new Error("token payload must not leak");
      },
    });
    expect(result).toEqual({
      authenticated: false,
      reason: "invalid_credential",
      configuredAccount: {
        email: "configured@example.com",
        displayName: "Configured",
      },
      drive: {
        configured: true,
        rootFolderId: "root-1",
        rootFolderName: "brain-hub",
      },
    });
    expect(JSON.stringify(result)).not.toContain("sensitive-token");
  });

  it("returns 需要重新登录 when Google answers invalid_grant", async () => {
    const result = await resolveGoogleAccountStatus({
      config: config(),
      credential: JSON.stringify({ refresh_token: "expired" }),
      loadAccount: async () => {
        const error = new Error("request failed") as Error & {
          response: { data: { error: string } };
        };
        error.response = { data: { error: "invalid_grant" } };
        throw error;
      },
    });
    expect(result).toMatchObject({
      authenticated: false,
      reason: "relogin_required",
      message: RELOGIN_REQUIRED_MESSAGE,
    });
  });

  it("treats a 7-day-old official refresh token as needing login", async () => {
    let calls = 0;
    const obtained = new Date("2026-01-01T00:00:00.000Z").getTime();
    const result = await resolveGoogleAccountStatus({
      config: config(),
      credential: JSON.stringify({
        refresh_token: "old",
        obtained_at: new Date(obtained).toISOString(),
      }),
      now: obtained + TEST_MODE_REFRESH_TTL_MS,
      loadAccount: async () => {
        calls += 1;
        throw new Error("must not call");
      },
    });
    expect(result).toMatchObject({
      authenticated: false,
      reason: "relogin_required",
      message: "需要重新登录",
    });
    expect(calls).toBe(0);
  });

  it("does not expire a custom-credential refresh token on the 7-day clock", async () => {
    const custom = config();
    custom.oauth = { mode: "custom", clientId: "mine.apps.googleusercontent.com" };
    const obtained = Date.parse("2026-01-01T00:00:00.000Z");
    const result = await resolveGoogleAccountStatus({
      config: custom,
      credential: JSON.stringify({
        refresh_token: "kept",
        obtained_at: new Date(obtained).toISOString(),
      }),
      now: obtained + TEST_MODE_REFRESH_TTL_MS + 1,
      loadAccount: async () => ({
        email: "ada@example.com",
        displayName: "Ada",
        permissionId: "perm",
      }),
    });
    expect(result.authenticated).toBe(true);
  });

  it("reuses a matching configured account", async () => {
    const connected = config();
    connected.driveRootId = "root-1";
    connected.account = {
      email: "person@example.com",
      displayName: "Person",
      permissionId: "permission-1",
    };
    await expect(
      resolveReusableGoogleAccount({
        config: connected,
        credential: "stored",
        loadAccount: async () => ({
          email: "person@example.com",
          displayName: "Person",
          permissionId: "permission-1",
        }),
      }),
    ).resolves.toEqual({ email: "person@example.com" });
  });
});
