import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { CommandExecutor } from "../../src/migrate/brainhub.js";
import {
  applyBrainHubDefaults,
  applyBrainHubMigration,
  planBrainHubMigration,
  restoreBrainHubMigration,
} from "../../src/migrate/brainhub.js";
import { createDefaultLocalConfig } from "../../src/domain/config.js";

function fakeExec(): { exec: CommandExecutor; calls: string[][] } {
  const calls: string[][] = [];
  const exec: CommandExecutor = async (command, args) => {
    calls.push([command, ...args]);
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { exec, calls };
}

async function writeDevice(path: string, id: string, name: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const database = new Database(path);
  database.exec(`
    CREATE TABLE device (
      singleton INTEGER PRIMARY KEY,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  database
    .query("INSERT INTO device(singleton, id, name, created_at) VALUES (1, ?, ?, ?)")
    .run(id, name, "2026-01-01T00:00:00.000Z");
  database.close();
}

describe("BrainHub migration", () => {
  it("plans defaults, schedules, and MCP entries without touching them", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-migrate-"));
    const configDir = join(root, "Library", "Application Support", "brainhub-mcp");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.toml"),
      'drive.root_folder_name = "brain-hub"\ndrive.root_folder_id = "folder-9"\n[device]\nname = "old-mac"\n',
    );
    const deviceId = "11111111-1111-4111-8111-111111111111";
    await writeDevice(join(configDir, "state.sqlite"), deviceId, "studio");
    await mkdir(join(root, "Library", "LaunchAgents"), { recursive: true });
    const plist = join(root, "Library", "LaunchAgents", "com.brainhub.upload.plist");
    await writeFile(plist, "<plist>upload</plist>\n");
    await mkdir(join(root, ".cursor"), { recursive: true });
    await writeFile(
      join(root, ".cursor", "mcp.json"),
      `${JSON.stringify({
        mcpServers: {
          "brain-hub": { command: "node", args: ["serve"] },
          other: { command: "other" },
        },
      })}\n`,
    );
    const before = await readFile(plist, "utf8");
    const { exec, calls } = fakeExec();
    const plan = await planBrainHubMigration({
      homeDir: root,
      platform: "darwin",
      uid: 501,
      exec,
    });
    expect(calls).toEqual([]);
    expect(plan.detected).toBe(true);
    expect(plan.defaults).toMatchObject({
      driveRoot: "brain-hub",
      driveRootId: "folder-9",
      deviceId,
      displayName: "studio",
    });
    expect(plan.items.map((item) => item.id)).toEqual([
      "schedule:upload",
      "mcp:.cursor/mcp.json",
    ]);
    expect(plan.items[1]?.preview).toContain("-");
    expect(await readFile(plist, "utf8")).toBe(before);
    const inherited = applyBrainHubDefaults(
      createDefaultLocalConfig({ hostname: "ignored", dataDir: root }),
      plan.defaults,
    );
    expect(inherited.deviceId).toBe(deviceId);
    expect(inherited.driveRootId).toBe("folder-9");
  });

  it("backs up, unloads with the injected executor, and restores", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-migrate-"));
    const configDir = join(root, "Library", "Application Support", "BrainHub");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.toml"),
      'drive.root_folder_id = "folder-real"\ndrive.root_folder_name = "brain-hub"\n',
    );
    await writeFile(join(configDir, "state.sqlite"), "not a database, leave me");
    await mkdir(join(root, "Library", "LaunchAgents"), { recursive: true });
    const plist = join(root, "Library", "LaunchAgents", "com.brainhub.sync.plist");
    await writeFile(plist, "<plist>sync</plist>\n");
    await mkdir(join(root, ".codex"), { recursive: true });
    const tomlPath = join(root, ".codex", "config.toml");
    await writeFile(
      tomlPath,
      '[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.brain-hub]\ncommand = "node"\nargs = ["serve"]\n',
    );
    const { exec, calls } = fakeExec();
    const context = { homeDir: root, platform: "darwin" as const, uid: 501, exec };
    const plan = await planBrainHubMigration(context);
    expect(plan.defaults.driveRootId).toBe("folder-real");
    const backupDir = join(root, "backup");
    const applied = await applyBrainHubMigration({
      context,
      plan,
      selectedIds: ["schedule:sync"],
      backupDir,
    });
    expect(applied.removed).toEqual(["schedule:sync"]);
    await expect(stat(plist)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(tomlPath, "utf8")).toContain("brain-hub");
    expect(await readFile(join(configDir, "config.toml"), "utf8")).toContain("folder-real");
    expect(await readFile(join(configDir, "state.sqlite"), "utf8")).toContain("leave me");
    expect(calls).toEqual([["launchctl", "bootout", "gui/501", plist]]);
    calls.length = 0;
    await restoreBrainHubMigration({ backupDir, exec });
    expect(await readFile(plist, "utf8")).toBe("<plist>sync</plist>\n");
    expect(calls[0]).toEqual(["launchctl", "bootstrap", "gui/501", plist]);
  });

  it("removes only the brainhub MCP entry that was selected", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-migrate-"));
    await mkdir(join(root, ".grok"), { recursive: true });
    const tomlPath = join(root, ".grok", "config.toml");
    await writeFile(
      tomlPath,
      'model = "grok"\n\n[mcp_servers.brain-hub]\ncommand = "node"\nargs = ["serve"]\n\n[mcp_servers.other]\ncommand = "keep"\n',
    );
    const { exec, calls } = fakeExec();
    const context = { homeDir: root, platform: "darwin" as const, uid: 501, exec };
    const plan = await planBrainHubMigration(context);
    await applyBrainHubMigration({
      context,
      plan,
      selectedIds: ["mcp:.grok/config.toml"],
      backupDir: join(root, "backup"),
    });
    const next = await readFile(tomlPath, "utf8");
    expect(next).toContain('model = "grok"');
    expect(next).toContain("[mcp_servers.other]");
    expect(next).not.toContain("brain-hub");
    expect(calls).toEqual([]);
    await restoreBrainHubMigration({ backupDir: join(root, "backup"), exec });
    expect(await readFile(tomlPath, "utf8")).toContain("[mcp_servers.brain-hub]");
  });

  it("disables systemd timers through the injected executor", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-migrate-"));
    const unitDir = join(root, ".config", "systemd", "user");
    await mkdir(unitDir, { recursive: true });
    await writeFile(join(unitDir, "brainhub-upload.timer"), "[Timer]\n");
    await writeFile(join(unitDir, "brainhub-upload.service"), "[Service]\n");
    const { exec, calls } = fakeExec();
    const context = {
      homeDir: root,
      platform: "linux" as const,
      env: { XDG_CONFIG_HOME: join(root, ".config") },
      exec,
    };
    const plan = await planBrainHubMigration(context);
    expect(plan.items.map((item) => item.id)).toEqual(["schedule:upload"]);
    await applyBrainHubMigration({
      context,
      plan,
      selectedIds: ["schedule:upload"],
      backupDir: join(root, "backup"),
    });
    await expect(stat(join(unitDir, "brainhub-upload.timer"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(calls).toContainEqual([
      "systemctl",
      "--user",
      "disable",
      "--now",
      "brainhub-upload.timer",
    ]);
    expect(calls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
    calls.length = 0;
    await restoreBrainHubMigration({ backupDir: join(root, "backup"), exec });
    expect(await readFile(join(unitDir, "brainhub-upload.service"), "utf8")).toBe("[Service]\n");
    expect(calls[0]).toEqual(["systemctl", "--user", "daemon-reload"]);
    expect(calls).toContainEqual([
      "systemctl",
      "--user",
      "enable",
      "--now",
      "brainhub-upload.timer",
    ]);
  });
});
