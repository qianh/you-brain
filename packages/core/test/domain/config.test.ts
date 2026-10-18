import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { YouBrainError } from "../../src/domain/errors.js";
import {
  createDefaultLocalConfig,
  loadLocalConfig,
  writeLocalConfig,
} from "../../src/domain/index.js";

async function tempDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), name));
}

describe("local config", () => {
  it("creates an immutable device id and official oauth defaults", async () => {
    const dataDir = await tempDir("you-brain-data-a-");
    const otherDir = await tempDir("you-brain-data-b-");
    const outputDir = await tempDir("you-brain-out-");
    const env = {
      YOU_BRAIN_DATA_DIR: dataDir,
      YOU_BRAIN_HOME: outputDir,
    };
    const first = await loadLocalConfig({
      homeDir: "/Users/test",
      platform: "darwin",
      hostname: "test-host",
      env,
    });
    expect(first.created).toBe(true);
    expect(first.config.displayName).toBe("test-host");
    expect(first.config.driveRoot).toBe("brain-hub");
    expect(first.config.driveRootId).toBe("");
    expect(first.config.oauth).toEqual({ mode: "official", clientId: "" });
    expect(first.config.dataDir).toBe(dataDir);
    expect(first.paths.outputDir).toBe(outputDir);
    expect(first.configFile).toBe(join(dataDir, "config.toml"));

    const renamed = {
      ...first.config,
      displayName: "MacBook Air",
      driveRootId: "folder-1",
      oauth: { mode: "custom" as const, clientId: "client.apps.googleusercontent.com" },
      account: {
        email: "ada@example.com",
        displayName: "Ada",
        permissionId: "perm-1",
      },
    };
    await writeLocalConfig(first.configFile, renamed);
    const second = await loadLocalConfig({
      homeDir: "/Users/test",
      platform: "darwin",
      hostname: "ignored",
      env,
    });
    expect(second.created).toBe(false);
    expect(second.config.deviceId).toBe(first.config.deviceId);
    expect(second.config.displayName).toBe("MacBook Air");
    expect(second.config.oauth.mode).toBe("custom");
    expect(second.config.account.email).toBe("ada@example.com");
    expect(await readFile(first.configFile, "utf8")).toContain(
      `device_id = "${first.config.deviceId}"`,
    );
    expect((await lstat(first.configFile)).mode & 0o777).toBe(0o600);

    const other = await loadLocalConfig({
      homeDir: "/Users/test",
      platform: "darwin",
      hostname: "other-host",
      env: { YOU_BRAIN_DATA_DIR: otherDir, YOU_BRAIN_HOME: outputDir },
    });
    expect(other.config.deviceId).not.toBe(first.config.deviceId);
    const again = await loadLocalConfig({
      homeDir: "/Users/test",
      platform: "darwin",
      hostname: "test-host",
      env,
    });
    expect(again.config.deviceId).toBe(first.config.deviceId);

    await expect(
      writeLocalConfig(first.configFile, {
        ...again.config,
        deviceId: randomUUID(),
      }),
    ).rejects.toThrow(YouBrainError);
    try {
      await writeLocalConfig(first.configFile, {
        ...again.config,
        deviceId: randomUUID(),
      });
    } catch (error) {
      expect((error as YouBrainError).code).toBe("DEVICE_ID_IMMUTABLE");
    }
    expect((await loadLocalConfig({
      homeDir: "/Users/test",
      platform: "darwin",
      hostname: "test-host",
      env,
    })).config.deviceId).toBe(first.config.deviceId);
  });

  it("preserves a config symlink while updating its target", async () => {
    const directory = await tempDir("you-brain-config-link-");
    const target = join(directory, "managed.toml");
    const link = join(directory, "config.toml");
    const config = createDefaultLocalConfig({
      hostname: "linked-device",
      dataDir: directory,
    });
    await writeLocalConfig(target, config);
    await symlink(target, link);
    await writeLocalConfig(link, { ...config, displayName: "renamed-device" });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toContain('display_name = "renamed-device"');
    const loaded = await loadLocalConfig({
      homeDir: "/Users/test",
      platform: "linux",
      hostname: "unused",
      env: { YOU_BRAIN_DATA_DIR: directory },
      configFile: link,
    });
    expect(loaded.config.deviceId).toBe(config.deviceId);
    expect(loaded.config.displayName).toBe("renamed-device");
  });

  it("rejects a corrupt config instead of replacing the device id", async () => {
    const directory = await tempDir("you-brain-config-bad-");
    const configFile = join(directory, "config.toml");
    await writeFile(configFile, "version = ");
    await expect(
      loadLocalConfig({
        homeDir: "/Users/test",
        platform: "linux",
        env: { YOU_BRAIN_DATA_DIR: directory },
        configFile,
      }),
    ).rejects.toThrow(YouBrainError);
  });
});
