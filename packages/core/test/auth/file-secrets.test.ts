import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { FileSecretStore, fileSecretKey } from "../../src/auth/file-secrets.js";
import {
  DEFAULT_SECRETS_FILE,
  createConfigSecretStore,
  createLlmSecretStore,
  resolveSecretBackend,
} from "../../src/auth/secret-store-factory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "you-brain-file-secrets-"));
  roots.push(root);
  return root;
}

describe("file secret store", () => {
  it("round-trips values and keeps separate keys apart", async () => {
    const root = await tempDir();
    const path = join(root, "secrets.json");
    const google = new FileSecretStore("you-brain", "config-abc", { path });
    const llm = new FileSecretStore("you-brain/llm/deepseek", "api-key", { path });

    await google.set("refresh-token-1");
    await llm.set("sk-deepseek");

    expect(await google.get()).toBe("refresh-token-1");
    expect(await llm.get()).toBe("sk-deepseek");

    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
    expect(Object.keys(raw).sort()).toEqual(
      [
        fileSecretKey("you-brain", "config-abc"),
        fileSecretKey("you-brain/llm/deepseek", "api-key"),
      ].sort(),
    );
  });

  it("writes the file with 0600", async () => {
    const root = await tempDir();
    const path = join(root, "secrets.json");
    await new FileSecretStore("you-brain", "config-abc", { path }).set("token");
    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("deletes one key without touching the others, and tolerates a missing file", async () => {
    const root = await tempDir();
    const path = join(root, "secrets.json");
    const store = new FileSecretStore("you-brain", "config-abc", { path });
    expect(await store.get()).toBeNull();
    await store.delete();

    await store.set("token");
    const other = new FileSecretStore("you-brain", "config-def", { path });
    await other.set("keep-me");
    await store.delete();

    expect(await store.get()).toBeNull();
    expect(await other.get()).toBe("keep-me");
  });

  it("treats a corrupt file as empty instead of failing the daemon", async () => {
    const root = await tempDir();
    const path = join(root, "secrets.json");
    await Bun.write(path, "{ not json");
    const store = new FileSecretStore("you-brain", "config-abc", { path });
    expect(await store.get()).toBeNull();
    await store.set("recovered");
    expect(await store.get()).toBe("recovered");
  });

  it("serializes concurrent writes so neither value is lost", async () => {
    const root = await tempDir();
    const path = join(root, "secrets.json");
    const a = new FileSecretStore("you-brain", "a", { path });
    const b = new FileSecretStore("you-brain", "b", { path });
    await Promise.all([a.set("1"), b.set("2"), a.set("3")]);
    expect(await a.get()).toBe("3");
    expect(await b.get()).toBe("2");
  });
});

describe("secret backend selection", () => {
  it("defaults to the keychain on a desktop and to the file on a server", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(resolveSecretBackend({ env, dataDir: "/data" })).toEqual({});
    expect(resolveSecretBackend({ env, dataDir: "/data", role: "desktop" })).toEqual({});
    expect(resolveSecretBackend({ env, dataDir: "/data", role: "server" })).toEqual({
      file: join("/data", DEFAULT_SECRETS_FILE),
    });
  });

  it("honours the explicit env overrides", () => {
    expect(
      resolveSecretBackend({ env: { YOU_BRAIN_SECRET_BACKEND: "file" }, dataDir: "/data" }),
    ).toEqual({ file: join("/data", DEFAULT_SECRETS_FILE) });
    expect(
      resolveSecretBackend({
        env: { YOU_BRAIN_SECRETS_FILE: "/run/secrets/you-brain.json" },
        dataDir: "/data",
      }),
    ).toEqual({ file: "/run/secrets/you-brain.json" });
    expect(
      resolveSecretBackend({
        env: { YOU_BRAIN_SECRET_BACKEND: "keychain" },
        dataDir: "/data",
        role: "server",
      }),
    ).toEqual({});
  });

  it("routes the config and LLM stores to the file backend", async () => {
    const root = await tempDir();
    const file = join(root, "secrets.json");
    const backend = { file };
    const config = createConfigSecretStore({
      platform: "linux",
      configFile: join(root, "config.toml"),
      backend,
    });
    await config.set("google-grant");
    expect(await config.get()).toBe("google-grant");

    const llm = createLlmSecretStore({ platform: "linux", provider: "deepseek", backend });
    await llm.set("sk-test");
    expect(await llm.get()).toBe("sk-test");

    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
    expect(Object.keys(raw)).toHaveLength(2);
  });
});
