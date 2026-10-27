import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { platformPaths, type YouBrainPaths } from "@you-brain/core";
import { MemoryDrive } from "@you-brain/core/drive";

import { runSetup, type SetupFlags, type SetupHooks } from "../src/setup.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function flags(extra: Partial<SetupFlags> = {}): SetupFlags {
  return {
    yes: true,
    inheritBrainhub: false,
    skipBrainhub: true,
    sources: [],
    integrations: "",
    backfill: false,
    ...extra,
  };
}

async function layout(): Promise<{
  homeDir: string;
  paths: YouBrainPaths;
  env: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(join(tmpdir(), "you-brain-setup-server-"));
  roots.push(root);
  const homeDir = join(root, "home");
  const env: NodeJS.ProcessEnv = {
    YOU_BRAIN_DATA_DIR: join(root, "data"),
    YOU_BRAIN_HOME: join(root, "out"),
  };
  const paths = platformPaths({ platform: "linux", homeDir, env });
  return { homeDir, paths, env };
}

interface Harness {
  hooks: SetupHooks;
  logs: string[];
  openOptions: Array<Record<string, unknown>>;
}

function harness(
  base: { homeDir: string; paths: YouBrainPaths; env: NodeJS.ProcessEnv },
  hooks: SetupHooks = {},
): Harness {
  const logs: string[] = [];
  const openOptions: Array<Record<string, unknown>> = [];
  return {
    logs,
    openOptions,
    hooks: {
      log: (message) => logs.push(message),
      isTTY: false,
      env: base.env,
      homeDir: base.homeDir,
      paths: base.paths,
      platform: "linux",
      hasOfficialOAuth: () => true,
      planBrainHubMigration: async () => ({
        detected: false,
        defaults: {},
        items: [],
        warnings: [],
      }),
      openGoogleDrive: async (options) => {
        openOptions.push(options as unknown as Record<string, unknown>);
        return {
          drive: new MemoryDrive(),
          config: {
            ...options.local,
            driveRootId: "folder-123",
            account: {
              email: "owner@example.com",
              displayName: "Owner",
              permissionId: "perm-1",
            },
          },
        };
      },
      ...hooks,
    },
  };
}

describe("setup --server", () => {
  it("writes role server, disables capture, and logs in headless", async () => {
    const base = await layout();
    const { hooks, logs, openOptions } = harness(base);
    await runSetup(flags({ role: "server" }), hooks);

    const config = await readFile(base.paths.configFile, "utf8");
    expect(config).toContain('role = "server"');

    const shared = JSON.parse(await readFile(join(base.paths.dataDir, "shared.json"), "utf8")) as {
      capture: { sources: Record<string, { enabled: boolean; paths: string[] }> };
    };
    for (const source of Object.values(shared.capture.sources)) {
      expect(source.enabled).toBe(false);
      expect(source.paths).toEqual([]);
    }

    expect(openOptions).toHaveLength(1);
    expect(openOptions[0]?.headless).toEqual({});
    expect(openOptions[0]?.secretBackend).toEqual({
      file: join(base.paths.dataDir, "secrets.json"),
    });

    expect(logs).toContain("服务器模式：不采集本机会话（采集来源全部关闭）。");
    expect(logs).toContain("服务器模式：跳过 AI 客户端接入。");
    expect(logs).toContain("服务器模式：跳过首次回填（本机没有会话）。");
    expect(logs.some((line) => line.includes("you-brain service install"))).toBe(true);
  });

  it("keeps desktop setup interactive-shaped: capture on, no headless login", async () => {
    const base = await layout();
    const { hooks, openOptions } = harness(base);
    await runSetup(flags({ yes: true }), hooks);

    const config = await readFile(base.paths.configFile, "utf8");
    expect(config).toContain('role = "desktop"');
    expect(openOptions[0]?.headless).toBeUndefined();
    expect(openOptions[0]?.secretBackend).toEqual({});
  });

  it("can switch an existing machine to server on a repeat run", async () => {
    const base = await layout();
    await mkdir(base.paths.dataDir, { recursive: true });
    const first = harness(base);
    await runSetup(flags(), first.hooks);
    expect(await readFile(base.paths.configFile, "utf8")).toContain('role = "desktop"');

    const second = harness(base);
    await runSetup(flags({ role: "server" }), second.hooks);
    expect(await readFile(base.paths.configFile, "utf8")).toContain('role = "server"');
    expect(existsSync(join(base.paths.dataDir, "secrets.json"))).toBe(false);
  });

  it("honours an explicit secret backend from the environment", async () => {
    const base = await layout();
    const path = join(base.paths.dataDir, "custom-secrets.json");
    const { hooks, openOptions } = harness(base, {
      env: { ...base.env, YOU_BRAIN_SECRETS_FILE: path },
    });
    await runSetup(flags({ role: "server" }), hooks);
    expect(openOptions[0]?.secretBackend).toEqual({ file: path });
  });

  it("does not create a secrets file just by running setup without a key", async () => {
    const base = await layout();
    const { hooks } = harness(base, {
      // 无 Key 的 provider 也会做一次连接测试。这里用本地 mock 代替真实网络。
      openGoogleDrive: async (options) => ({
        drive: new MemoryDrive(),
        config: {
          ...options.local,
          driveRootId: "folder-123",
          account: {
            email: "owner@example.com",
            displayName: "Owner",
            permissionId: "perm-1",
          },
        },
      }),
    });
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ choices: [{ message: { content: "ok" } }] }),
    });
    try {
      await runSetup(
        flags({
          role: "server",
          provider: "custom",
          model: "test",
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          apiKey: "sk-test",
        }),
        hooks,
      );
    } finally {
      server.stop(true);
    }
    // 显式给了 Key，文件后端会被写出来，但只有 LLM 那一条。
    const secrets = JSON.parse(
      await readFile(join(base.paths.dataDir, "secrets.json"), "utf8"),
    ) as Record<string, string>;
    expect(Object.keys(secrets)).toEqual(["you-brain/llm/custom\u0000api-key"]);
  });
});

describe("config role default", () => {
  it("reads an old config without role as desktop", async () => {
    const base = await layout();
    await mkdir(base.paths.dataDir, { recursive: true });
    await writeFile(
      base.paths.configFile,
      [
        "version = 1",
        'device_id = "11111111-1111-4111-8111-111111111111"',
        'display_name = "old-device"',
        'drive_root = "brain-hub"',
        'drive_root_id = ""',
        'data_dir = "' + base.paths.dataDir + '"',
        "",
        "[oauth]",
        'mode = "official"',
        'client_id = ""',
        "",
        "[account]",
        'email = ""',
        'display_name = ""',
        'permission_id = ""',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const { loadLocalConfig } = await import("@you-brain/core");
    const loaded = await loadLocalConfig({
      homeDir: base.homeDir,
      platform: "linux",
      env: base.env,
      configFile: base.paths.configFile,
    });
    expect(loaded.config.role).toBe("desktop");
  });
});
