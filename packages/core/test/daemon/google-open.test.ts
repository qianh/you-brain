import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { MISSING_OFFICIAL_OAUTH_MESSAGE } from "../../src/auth/official-oauth-client.js";
import { MemorySecretStore } from "../../src/auth/secret-store.js";
import { createDefaultLocalConfig } from "../../src/domain/config.js";
import { YouBrainError } from "../../src/domain/errors.js";
import { writeLocalConfig } from "../../src/domain/config-io.js";
import { describeGoogleDriveOpenError, openGoogleDrive } from "../../src/daemon/google.js";

const ENV_KEYS = [
  "YOU_BRAIN_BUNDLED_OAUTH_CLIENT_ID",
  "YOU_BRAIN_BUNDLED_OAUTH_CLIENT_SECRET",
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

function isolateBundledEnv(): void {
  for (const key of ENV_KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    delete process.env[key];
  }
}

describe("describeGoogleDriveOpenError", () => {
  it("names missing credentials, cancel, timeout, port, invalid_grant, and network failures", () => {
    expect(
      describeGoogleDriveOpenError(new YouBrainError("AUTH_REQUIRED", MISSING_OFFICIAL_OAUTH_MESSAGE)),
    ).toBe(MISSING_OFFICIAL_OAUTH_MESSAGE);
    expect(describeGoogleDriveOpenError(new Error("OAuth authorization was cancelled"))).toBe(
      "Google 登录已取消",
    );
    expect(describeGoogleDriveOpenError(new Error("access_denied"))).toBe("Google 登录已取消");
    expect(describeGoogleDriveOpenError(new Error("OAuth callback timed out"))).toBe(
      "Google 登录等待超时，请重试",
    );
    const busy = Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:0"), {
      code: "EADDRINUSE",
    });
    expect(describeGoogleDriveOpenError(busy)).toBe(
      "本地授权端口被占用，请关闭占用 127.0.0.1 的程序后重试",
    );
    expect(describeGoogleDriveOpenError(new Error("OAuth callback validation failed"))).toBe(
      "Google 登录回调校验失败",
    );
    const invalid = Object.assign(new Error("invalid_grant"), {
      response: { data: { error: "invalid_grant" } },
    });
    expect(describeGoogleDriveOpenError(invalid)).toBe(
      "Google 授权无效（invalid_grant），请重新登录",
    );
    expect(describeGoogleDriveOpenError(new Error("Google did not return a refresh token"))).toBe(
      "Google 未返回 refresh token，请在授权页重新同意后重试",
    );
    const network = new Error("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }),
    });
    expect(describeGoogleDriveOpenError(network)).toBe("连接 Google 失败：fetch failed");
    expect(describeGoogleDriveOpenError(new Error("socket hang up"))).toBe(
      "连接 Google 失败：socket hang up",
    );
  });
});

describe("openGoogleDrive official credentials", () => {
  it("throws the missing-credential message interactively and returns null otherwise", async () => {
    isolateBundledEnv();
    const root = await mkdtemp(join(tmpdir(), "you-brain-google-open-"));
    const configFile = join(root, "config.toml");
    const local = createDefaultLocalConfig({ hostname: "device", dataDir: root });
    await writeLocalConfig(configFile, local);
    const options = {
      local,
      configFile,
      platform: "darwin" as const,
      env: {},
      secrets: new MemorySecretStore(null),
    };
    await expect(openGoogleDrive({ ...options, interactive: true })).rejects.toEqual(
      expect.objectContaining({
        code: "AUTH_REQUIRED",
        message: MISSING_OFFICIAL_OAUTH_MESSAGE,
      }),
    );
    await expect(openGoogleDrive({ ...options, interactive: false })).resolves.toBeNull();
  });
});
