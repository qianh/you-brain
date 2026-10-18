import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import TOML from "@iarna/toml";
import { z } from "zod";

import { writeFileAtomic } from "../domain/atomic.js";
import { YouBrainError } from "../domain/errors.js";
import {
  brainHubServerNames,
  previewJsonMcp,
  previewTomlMcp,
  readTextIfPresent,
} from "../clients/mcp-config.js";
import { previewDiff } from "../clients/diff.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandExecutor = (
  command: string,
  args: string[],
) => Promise<CommandResult>;

export const defaultCommandExecutor: CommandExecutor = async (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      resolve({ stdout: "", stderr: error.message, exitCode: 127 });
    });
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });

export interface MigrateContext {
  homeDir: string;
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  exec?: CommandExecutor;
  now?: () => Date;
}

export interface BrainHubDefaults {
  configFile?: string;
  driveRoot?: string;
  driveRootId?: string;
  deviceId?: string;
  displayName?: string;
}

export interface BrainHubMigrationItem {
  id: string;
  kind: "schedule" | "mcp";
  description: string;
  paths: string[];
  serverNames?: string[];
  preview: string;
}

export interface BrainHubMigrationPlan {
  detected: boolean;
  defaults: BrainHubDefaults;
  items: BrainHubMigrationItem[];
  warnings: string[];
}

interface BackupFile {
  path: string;
  backupName: string;
}

interface BackupItem {
  id: string;
  kind: "schedule" | "mcp";
  files: BackupFile[];
  serverNames?: string[];
  format?: "json" | "toml";
}

interface BackupManifest {
  version: 1;
  createdAt: string;
  platform: string;
  uid: number;
  items: BackupItem[];
}

const MCP_FILES: Array<{ path: string; format: "json" | "toml" }> = [
  { path: ".claude.json", format: "json" },
  { path: ".claude/settings.json", format: "json" },
  { path: ".cursor/mcp.json", format: "json" },
  { path: ".gemini/settings.json", format: "json" },
  { path: ".codex/config.toml", format: "toml" },
  { path: ".grok/config.toml", format: "toml" },
];

function camelKey(value: string): string {
  return value.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

function mapKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => mapKeys(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [camelKey(key), mapKeys(child)]),
  );
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function configCandidates(context: MigrateContext): string[] {
  const env = context.env ?? {};
  if (context.platform === "darwin") {
    return [
      join(context.homeDir, "Library", "Application Support", "brainhub-mcp", "config.toml"),
      join(context.homeDir, "Library", "Application Support", "BrainHub", "config.toml"),
    ];
  }
  const configHome =
    nonempty(env.XDG_CONFIG_HOME) ?? join(context.homeDir, ".config");
  return [join(configHome, "brainhub-mcp", "config.toml")];
}

function stateCandidates(context: MigrateContext, configFile: string): string[] {
  const directory = dirname(configFile);
  const paths = [join(directory, "state.sqlite")];
  const accounts = join(directory, "accounts");
  if (existsSync(accounts)) {
    for (const child of readdirSync(accounts)) {
      paths.push(join(accounts, child, "state.sqlite"));
    }
  }
  if (context.platform === "linux") {
    const env = context.env ?? {};
    const stateHome = nonempty(env.XDG_STATE_HOME) ?? join(context.homeDir, ".local", "state");
    paths.push(join(stateHome, "brainhub-mcp", "state.sqlite"));
  }
  return paths;
}

function readDevice(path: string): { id: string; name: string } | undefined {
  if (!existsSync(path)) return undefined;
  let database: Database | undefined;
  try {
    database = new Database(path, { readonly: true });
    const row = database
      .query("SELECT id, name FROM device WHERE singleton = 1")
      .get() as { id?: unknown; name?: unknown } | null;
    if (!row || typeof row.id !== "string") return undefined;
    return {
      id: row.id,
      name: typeof row.name === "string" ? row.name : "",
    };
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}

function readConfig(path: string): {
  driveRoot?: string;
  driveRootId?: string;
  displayName?: string;
} {
  const parsed = mapKeys(TOML.parse(readFileSync(path, "utf8"))) as {
    drive?: { rootFolderId?: unknown; rootFolderName?: unknown };
    device?: { name?: unknown };
  };
  const driveRoot = nonempty(parsed.drive?.rootFolderName);
  const driveRootId = nonempty(parsed.drive?.rootFolderId);
  const displayName = nonempty(parsed.device?.name);
  return {
    ...(driveRoot ? { driveRoot } : {}),
    ...(driveRootId ? { driveRootId } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

async function loadDefaults(context: MigrateContext): Promise<BrainHubDefaults> {
  let chosen: string | undefined;
  let chosenScore = -1;
  for (const candidate of configCandidates(context)) {
    if (!existsSync(candidate)) continue;
    let score = 1;
    try {
      const config = readConfig(candidate);
      if (config.driveRootId) score += 2;
      if (!chosen || score > chosenScore) {
        chosen = candidate;
        chosenScore = score;
      }
    } catch {
      if (!chosen) chosen = candidate;
    }
  }
  if (!chosen) return {};
  let defaults: BrainHubDefaults = { configFile: chosen };
  try {
    defaults = { ...defaults, ...readConfig(chosen) };
  } catch {
    defaults = { ...defaults };
  }
  for (const stateFile of stateCandidates(context, chosen)) {
    const device = readDevice(stateFile);
    if (!device) continue;
    if (z.uuid().safeParse(device.id).success) defaults.deviceId = device.id;
    if (device.name) defaults.displayName = device.name;
    break;
  }
  return defaults;
}

function scheduleGroups(context: MigrateContext): Array<{
  id: string;
  description: string;
  paths: string[];
  unit?: string;
}> {
  if (context.platform === "darwin") {
    const directory = join(context.homeDir, "Library", "LaunchAgents");
    return [
      {
        id: "schedule:upload",
        description: "停用 BrainHub 上传定时任务",
        paths: [join(directory, "com.brainhub.upload.plist")],
      },
      {
        id: "schedule:sync",
        description: "停用 BrainHub 画像同步定时任务",
        paths: [join(directory, "com.brainhub.sync.plist")],
      },
    ];
  }
  const env = context.env ?? {};
  const configHome = nonempty(env.XDG_CONFIG_HOME) ?? join(context.homeDir, ".config");
  const directory = join(configHome, "systemd", "user");
  return [
    {
      id: "schedule:upload",
      description: "停用 BrainHub 上传定时任务",
      unit: "brainhub-upload.timer",
      paths: [
        join(directory, "brainhub-upload.timer"),
        join(directory, "brainhub-upload.service"),
      ],
    },
    {
      id: "schedule:sync",
      description: "停用 BrainHub 画像同步定时任务",
      unit: "brainhub-sync.timer",
      paths: [
        join(directory, "brainhub-sync.timer"),
        join(directory, "brainhub-sync.service"),
      ],
    },
  ];
}

function uidOf(context: MigrateContext): number {
  if (context.uid !== undefined) return context.uid;
  return process.getuid?.() ?? 0;
}

export async function planBrainHubMigration(
  context: MigrateContext,
): Promise<BrainHubMigrationPlan> {
  const warnings: string[] = [];
  let defaults: BrainHubDefaults = {};
  try {
    defaults = await loadDefaults(context);
  } catch (error) {
    warnings.push(
      error instanceof Error ? error.message : "Unable to read BrainHub configuration",
    );
  }
  const items: BrainHubMigrationItem[] = [];
  for (const group of scheduleGroups(context)) {
    const present = group.paths.filter((path) => existsSync(path));
    if (present.length === 0) continue;
    const preview = [
      group.description,
      ...present.map((path) => `备份并移除 ${path}`),
      context.platform === "darwin"
        ? `launchctl bootout gui/${uidOf(context)} ${present[0]}`
        : `systemctl --user disable --now ${group.unit ?? ""}`,
    ].join("\n");
    items.push({
      id: group.id,
      kind: "schedule",
      description: group.description,
      paths: present,
      preview,
    });
  }
  for (const file of MCP_FILES) {
    const path = join(context.homeDir, file.path);
    const source = await readTextIfPresent(path);
    if (source === null) continue;
    let names: string[];
    try {
      names = brainHubServerNames(source, file.format);
    } catch (error) {
      warnings.push(
        `${path}: ${error instanceof Error ? error.message : "无法读取 MCP 配置"}`,
      );
      continue;
    }
    if (names.length === 0) continue;
    let next = source;
    try {
      for (const name of names) {
        next =
          file.format === "json"
            ? previewJsonMcp(next, name, null)
            : previewTomlMcp(next, name, null);
      }
    } catch (error) {
      warnings.push(
        `${path}: ${error instanceof Error ? error.message : "无法预览 MCP 配置"}`,
      );
      continue;
    }
    items.push({
      id: `mcp:${file.path}`,
      kind: "mcp",
      description: `从 ${file.path} 移除 BrainHub MCP 条目`,
      paths: [path],
      serverNames: names,
      preview: previewDiff(path, source, next),
    });
  }
  const detected = Boolean(defaults.configFile) || items.length > 0;
  return { detected, defaults, items, warnings };
}

function manifestPath(backupDir: string): string {
  return join(backupDir, "manifest.json");
}

export async function applyBrainHubMigration(options: {
  context: MigrateContext;
  plan: BrainHubMigrationPlan;
  selectedIds: readonly string[];
  backupDir: string;
}): Promise<{ backupDir: string; removed: string[] }> {
  const selected = options.plan.items.filter((item) =>
    options.selectedIds.includes(item.id),
  );
  const unknown = options.selectedIds.filter(
    (id) => !options.plan.items.some((item) => item.id === id),
  );
  if (unknown.length > 0) {
    throw new YouBrainError(
      "INVALID_INPUT",
      `Unknown BrainHub migration item: ${unknown.join(", ")}`,
    );
  }
  if (selected.length === 0) return { backupDir: options.backupDir, removed: [] };
  const exec = options.context.exec ?? defaultCommandExecutor;
  const uid = uidOf(options.context);
  await mkdir(join(options.backupDir, "files"), { recursive: true });
  const backupItems: BackupItem[] = [];
  for (const [index, item] of selected.entries()) {
    const files: BackupFile[] = [];
    for (const path of item.paths) {
      const backupName = `${String(index).padStart(2, "0")}-${basename(path)}`;
      await copyFile(path, join(options.backupDir, "files", backupName));
      files.push({ path, backupName });
    }
    const format = item.paths[0]?.endsWith(".toml") ? "toml" : "json";
    backupItems.push({
      id: item.id,
      kind: item.kind,
      files,
      ...(item.serverNames ? { serverNames: item.serverNames } : {}),
      ...(item.kind === "mcp" ? { format } : {}),
    });
  }
  const manifest: BackupManifest = {
    version: 1,
    createdAt: (options.context.now ?? (() => new Date()))().toISOString(),
    platform: options.context.platform,
    uid,
    items: backupItems,
  };
  await writeFileAtomic(manifestPath(options.backupDir), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const item of selected) {
    if (item.kind === "schedule") {
      await unloadSchedule(options.context, item.paths, exec, uid);
      for (const path of item.paths) await rm(path, { force: true });
      continue;
    }
    const path = item.paths[0];
    if (!path) continue;
    const source = await readTextIfPresent(path);
    if (source === null) continue;
    const format = path.endsWith(".toml") ? "toml" : "json";
    let next = source;
    for (const name of item.serverNames ?? []) {
      next = format === "json" ? previewJsonMcp(next, name, null) : previewTomlMcp(next, name, null);
    }
    await writeFileAtomic(path, next.endsWith("\n") ? next : `${next}\n`, { mode: 0o600 });
  }
  if (options.context.platform === "linux" && selected.some((item) => item.kind === "schedule")) {
    await exec("systemctl", ["--user", "daemon-reload"]);
  }
  return { backupDir: options.backupDir, removed: selected.map((item) => item.id) };
}

async function unloadSchedule(
  context: MigrateContext,
  paths: string[],
  exec: CommandExecutor,
  uid: number,
): Promise<void> {
  if (context.platform === "darwin") {
    for (const path of paths) {
      await exec("launchctl", ["bootout", `gui/${uid}`, path]);
    }
    return;
  }
  for (const path of paths) {
    if (!path.endsWith(".timer")) continue;
    await exec("systemctl", ["--user", "disable", "--now", basename(path)]);
  }
}

export async function restoreBrainHubMigration(options: {
  backupDir: string;
  exec?: CommandExecutor;
}): Promise<{ restored: string[] }> {
  const source = await readTextIfPresent(manifestPath(options.backupDir));
  if (source === null) {
    throw new YouBrainError("INVALID_INPUT", "BrainHub backup manifest is missing");
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(source) as BackupManifest;
  } catch {
    throw new YouBrainError("INVALID_INPUT", "BrainHub backup manifest is invalid");
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.items)) {
    throw new YouBrainError("INVALID_INPUT", "BrainHub backup manifest is invalid");
  }
  const exec = options.exec ?? defaultCommandExecutor;
  const restored: string[] = [];
  for (const item of manifest.items) {
    for (const file of item.files) {
      await mkdir(dirname(file.path), { recursive: true });
      await copyFile(join(options.backupDir, "files", file.backupName), file.path);
    }
    restored.push(item.id);
  }
  const schedules = manifest.items.filter((item) => item.kind === "schedule");
  if (manifest.platform === "linux" && schedules.length > 0) {
    const reloaded = await exec("systemctl", ["--user", "daemon-reload"]);
    if (reloaded.exitCode !== 0) {
      throw new YouBrainError(
        "INVALID_INPUT",
        `systemctl daemon-reload failed: ${reloaded.stderr || reloaded.stdout}`,
      );
    }
  }
  for (const item of schedules) {
    for (const file of item.files) {
      if (manifest.platform === "darwin" && file.path.endsWith(".plist")) {
        const result = await exec("launchctl", [
          "bootstrap",
          `gui/${manifest.uid}`,
          file.path,
        ]);
        if (result.exitCode !== 0) {
          throw new YouBrainError(
            "INVALID_INPUT",
            `launchctl bootstrap failed: ${result.stderr || result.stdout}`,
          );
        }
      }
      if (manifest.platform === "linux" && file.path.endsWith(".timer")) {
        const result = await exec("systemctl", [
          "--user",
          "enable",
          "--now",
          basename(file.path),
        ]);
        if (result.exitCode !== 0) {
          throw new YouBrainError(
            "INVALID_INPUT",
            `systemctl enable failed: ${result.stderr || result.stdout}`,
          );
        }
      }
    }
  }
  return { restored };
}

export function applyBrainHubDefaults<T extends {
  driveRoot: string;
  driveRootId: string;
  deviceId: string;
  displayName: string;
}>(config: T, defaults: BrainHubDefaults): T {
  return {
    ...config,
    ...(defaults.driveRoot ? { driveRoot: defaults.driveRoot } : {}),
    ...(defaults.driveRootId ? { driveRootId: defaults.driveRootId } : {}),
    ...(defaults.deviceId ? { deviceId: defaults.deviceId } : {}),
    ...(defaults.displayName ? { displayName: defaults.displayName } : {}),
  };
}
