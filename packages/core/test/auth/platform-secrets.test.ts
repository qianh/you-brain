import { describe, expect, it } from "bun:test";

import { YOU_BRAIN_KEYCHAIN_SERVICE } from "../../src/auth/platform-secrets.js";
import { PlatformSecretStore, type CommandRunner } from "../../src/auth/platform-secrets.js";
import {
  LLM_KEYCHAIN_ACCOUNT,
  createConfigSecretStore,
  createLlmSecretStore,
  credentialStoreAccount,
  llmKeychainKey,
  oauthClientSecretAccount,
} from "../../src/auth/secret-store-factory.js";
import { MemoryKeychain } from "../../src/auth/secret-store.js";
import { deleteLlmApiKey, getLlmApiKey, setLlmApiKey } from "../../src/auth/llm-secrets.js";

describe("platform secret storage", () => {
  it("uses the you-brain macOS keychain service through an injected runner", async () => {
    const calls: Array<{ command: string; args: string[]; input: string | undefined }> = [];
    const store = new PlatformSecretStore({
      platform: "darwin",
      account: "config-abc",
      runner: async (command, args, input) => {
        calls.push({ command, args, input });
        return command === "security" && args[0] === "find-generic-password"
          ? "token-value\n"
          : "";
      },
    });

    await store.set("refresh-secret");
    expect(await store.get()).toBe("token-value");
    expect(calls[0]).toMatchObject({ command: "security" });
    expect(calls[0]?.args).toContain(YOU_BRAIN_KEYCHAIN_SERVICE);
    expect(calls[0]?.args.slice(-2)).toEqual(["-w", "refresh-secret"]);
    expect(calls[0]?.input).toBeUndefined();
    expect(calls.some((call) => call.command !== "security")).toBe(false);
  });

  it("rejects secret storage outside macOS and Linux", () => {
    expect(
      () => new PlatformSecretStore({ platform: "win32", account: "default" }),
    ).toThrow(/you-brain supports macOS and Linux/);
  });

  it("stores Linux secrets through secret-tool stdin under you-brain", async () => {
    const values = new Map<string, string>();
    const calls: Array<{ args: string[]; input: string | undefined }> = [];
    const runner: CommandRunner = async (command, args, input) => {
      expect(command).toBe("secret-tool");
      calls.push({ args, input });
      const service = args[args.indexOf("service") + 1] ?? "";
      const account = args[args.indexOf("account") + 1] ?? "";
      const key = `${service}:${account}`;
      if (args[0] === "search") return "";
      if (args[0] === "lookup") {
        if (!values.has(key)) {
          const error = new Error("secret-tool exited with 1:") as Error & {
            exitCode: number;
          };
          error.exitCode = 1;
          throw error;
        }
        return `${values.get(key)}\n`;
      }
      if (args[0] === "store") {
        values.set(key, input ?? "");
        return "";
      }
      if (args[0] === "clear") {
        if (!values.has(key)) {
          const error = new Error("secret-tool exited with 1:") as Error & {
            exitCode: number;
          };
          error.exitCode = 1;
          throw error;
        }
        values.delete(key);
        return "";
      }
      throw new Error(`unexpected ${args[0]}`);
    };
    const store = new PlatformSecretStore({
      platform: "linux",
      account: "config-abc",
      runner,
    });

    await store.probe();
    await store.set("refresh-secret");
    expect(await store.get()).toBe("refresh-secret");
    await store.delete();
    await store.delete();
    expect(await store.get()).toBeNull();
    expect(calls[0]?.args).toEqual(["search", "service", YOU_BRAIN_KEYCHAIN_SERVICE]);
    expect(calls[1]).toEqual({
      args: [
        "store",
        "--label",
        "you-brain",
        "service",
        YOU_BRAIN_KEYCHAIN_SERVICE,
        "account",
        "config-abc",
      ],
      input: "refresh-secret",
    });
    expect(calls[1]?.args).not.toContain("refresh-secret");
  });

  it("keeps API keys in memory under you-brain/llm/<provider>", async () => {
    const memory = new MemoryKeychain();
    await setLlmApiKey("deepseek", "sk-test", { platform: "darwin", memory });
    expect(llmKeychainKey("deepseek")).toBe("you-brain/llm/deepseek");
    expect(memory.get("you-brain/llm/deepseek", LLM_KEYCHAIN_ACCOUNT)).toBe("sk-test");
    await expect(getLlmApiKey("deepseek", { platform: "darwin", memory })).resolves.toBe(
      "sk-test",
    );
    await deleteLlmApiKey("deepseek", { platform: "darwin", memory });
    await expect(getLlmApiKey("deepseek", { platform: "darwin", memory })).resolves.toBeNull();
    expect(() => createLlmSecretStore({ platform: "darwin", provider: "nope", memory })).toThrow();
  });

  it("separates the OAuth client secret from the refresh token", () => {
    const configFile = "/tmp/you-brain/config.toml";
    expect(oauthClientSecretAccount(configFile)).not.toBe(
      credentialStoreAccount(configFile),
    );
    expect(oauthClientSecretAccount(configFile)).toContain("oauth-client-secret");
  });

  it("migrates a legacy account inside the you-brain service using memory", async () => {
    const memory = new MemoryKeychain();
    memory.set(YOU_BRAIN_KEYCHAIN_SERVICE, "same-device", "legacy-token");
    const configFile = "/tmp/one/config.toml";
    const store = createConfigSecretStore({
      platform: "darwin",
      configFile,
      legacyAccount: "same-device",
      memory,
    });
    await expect(store.get()).resolves.toBe("legacy-token");
    expect(
      memory.get(YOU_BRAIN_KEYCHAIN_SERVICE, credentialStoreAccount(configFile)),
    ).toBe("legacy-token");
    expect(memory.get(YOU_BRAIN_KEYCHAIN_SERVICE, "same-device")).toBeNull();
  });

  it("uses a stable credential account per resolved config file", () => {
    expect(credentialStoreAccount("/tmp/a/../a/config.toml")).toBe(
      credentialStoreAccount("/tmp/a/config.toml"),
    );
    expect(credentialStoreAccount("/tmp/a/config.toml")).not.toBe(
      credentialStoreAccount("/tmp/b/config.toml"),
    );
  });
});
