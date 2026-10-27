import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createDefaultSharedConfig,
  parseRoles,
  parseSharedConfig,
  type SharedConfig,
} from "@you-brain/protocol";
import { getLlmApiKey, resolveSecretBackend } from "@you-brain/core/auth";
import { createDrivePortrait, localDayKey, rebuildTwin } from "@you-brain/core/consolidate";
import { openGoogleDrive } from "@you-brain/core/daemon";
import { isProcessAlive } from "@you-brain/core/http";
import { createLlmBackend } from "@you-brain/core/llm";
import {
  applyClientIntegrations,
  planClientIntegrations,
  planClientUninstall,
  type IntegrationPlanItem,
} from "@you-brain/core/clients";
import { restoreBrainHubMigration } from "@you-brain/core/migrate";
import {
  FilePortraitConsentStore,
  grantIntegrationConsent,
  portraitConsentPath,
  revokeIntegrationConsent,
} from "@you-brain/core/portrait";
import type { SessionSource } from "@you-brain/core";
import { SESSION_SOURCES, loadLocalConfig } from "@you-brain/core";

import { CliError, runtimePaths, supportedPlatform } from "./env.js";
import { createRuntimeServiceManager } from "./service/manager.js";
import { serviceUnitPath } from "./service/paths.js";

export async function listIntegrations(only: string[] | undefined): Promise<void> {
  const plan = await planClientIntegrations({
    homeDir: homedir(),
    managedStatePath: managedStatePath(),
    ...(only ? { clients: parseClients(only) } : {}),
  });
  if (plan.items.length === 0) {
    console.log("没有检测到 AI 工具接入。");
    return;
  }
  for (const item of plan.items) console.log(line(item));
}

export async function applyIntegrations(options: {
  yes: boolean;
  only?: string[];
  intent: "install" | "uninstall";
}): Promise<void> {
  const homeDir = homedir();
  const managedStatePathValue = managedStatePath();
  const plan =
    options.intent === "uninstall"
      ? await planClientUninstall({
          homeDir,
          managedStatePath: managedStatePathValue,
          ...(options.only ? { clients: parseClients(options.only) } : {}),
        })
      : await planClientIntegrations({
          homeDir,
          managedStatePath: managedStatePathValue,
          ...(options.only ? { clients: parseClients(options.only) } : {}),
        });
  const selected: string[] = [];
  for (const item of plan.items) {
    console.log(line(item));
    if (item.action === "unchanged" || item.action === "skipped") continue;
    if (options.yes || (await confirm(`${options.intent === "uninstall" ? "撤销" : "应用"} ${item.id}？`))) {
      selected.push(item.id);
    }
  }
  const result = await applyClientIntegrations({
    homeDir,
    plan,
    selectedIds: selected,
    managedStatePath: managedStatePathValue,
  });
  if (selected.length > 0) {
    const paths = runtimePaths();
    const store = new FilePortraitConsentStore(portraitConsentPath(paths.dataDir));
    if (options.intent === "uninstall") {
      await revokeIntegrationConsent(store, selected);
    } else {
      await grantIntegrationConsent(store, selected, codingVariantPath(paths.dataDir));
    }
  }
  console.log(`完成 ${result.applied.length} 项，跳过 ${result.skipped.length} 项`);
}

function codingVariantPath(dataDir: string): string {
  return (
    readLocalShared(dataDir).portrait.variants.find((variant) => variant.id === "coding")?.path ??
    "digital-twin/JOHN-TWIN-coding.md"
  );
}

function readLocalShared(dataDir: string): SharedConfig {
  const file = join(dataDir, "shared.json");
  if (!existsSync(file)) return createDefaultSharedConfig();
  try {
    return parseSharedConfig(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch {
    return createDefaultSharedConfig();
  }
}

/** Rebuild the three twin layers on Drive from the current files, without the daemon. */
export async function rebuildPortrait(options: { timeoutSeconds: number }): Promise<void> {
  const platform = supportedPlatform();
  const homeDir = homedir();
  const loaded = await loadLocalConfig({ homeDir, platform, env: process.env });
  const dataDir = loaded.paths.dataDir;
  const secretBackend = resolveSecretBackend({ env: process.env, dataDir, role: loaded.config.role });
  const shared = readLocalShared(dataDir);
  const rolesFile = join(dataDir, "roles.json");
  const roles = parseRoles(existsSync(rolesFile) ? (JSON.parse(readFileSync(rolesFile, "utf8")) as unknown) : {});
  const opened = await openGoogleDrive({
    local: loaded.config,
    configFile: loaded.configFile,
    platform,
    interactive: false,
    secretBackend,
  });
  if (!opened) {
    throw new CliError("打不开 Google Drive：未登录，或当前运行的不是内置官方 OAuth 凭据的构建");
  }
  const llm = await createLlmBackend({
    config: shared.llm,
    getApiKey: (provider) => getLlmApiKey(provider, { platform, backend: secretBackend }),
    dataDir,
    env: process.env,
    homeDir,
    timeoutMs: options.timeoutSeconds * 1000,
  });
  const portrait = createDrivePortrait({
    drive: opened.drive,
    driveRoot: opened.config.driveRoot,
    config: () => ({
      variants: shared.portrait.variants,
      snapshotPattern: shared.portrait.snapshotPattern,
    }),
    events: () => [],
  });
  const result = await rebuildTwin({
    llm,
    portrait,
    day: localDayKey(new Date(), roles.timezone),
    log: (line) => console.log(line),
  });
  console.log(
    `已重建为 v${result.version}：full ${result.sizes.full} 字节，coding ${result.sizes.coding} 字节，projects 最大小节 ${result.sizes.maxSection} 字节，共 ${result.claims} 条主张`,
  );
  for (const warning of result.warnings) console.log(`提示：${warning}`);
}

export async function restoreBrainHub(backupDir: string): Promise<void> {
  const result = await restoreBrainHubMigration({ backupDir });
  console.log(`已恢复 ${result.restored.length} 项 BrainHub 配置`);
}

export async function uninstall(options: { yes: boolean; deleteData: boolean }): Promise<void> {
  const homeDir = homedir();
  const paths = runtimePaths();
  await applyIntegrations({
    yes: options.yes,
    intent: "uninstall",
  });
  const removed = await removeStartupItems(homeDir);
  for (const path of removed) console.log(`已删除开机项 ${path}`);
  if (!options.deleteData) {
    console.log("本地数据仍保留。加上 --delete-data 可删除。");
    return;
  }
  if (!options.yes) {
    const accepted = await confirm("删除本地数据库、配置和输出目录？此操作不能撤销。");
    if (!accepted) {
      console.log("已保留本地数据。");
      return;
    }
  }
  assertDaemonStopped(paths.lockFile);
  await rm(paths.dataDir, { recursive: true, force: true });
  await rm(paths.outputDir, { recursive: true, force: true });
  console.log("已删除本地数据。");
}

function assertDaemonStopped(lockFile: string): void {
  if (!existsSync(lockFile)) return;
  let pid: number | null = null;
  try {
    const parsed = JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: unknown };
    pid = typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    pid = null;
  }
  if (pid !== null && isProcessAlive(pid)) {
    throw new CliError(`you-brain daemon 正在运行（pid ${pid}）。请先停止再删除数据。`);
  }
}

async function removeStartupItems(homeDir: string): Promise<string[]> {
  const ordered = [serviceUnitPath("darwin", homeDir), serviceUnitPath("linux", homeDir)];
  const present = new Set(ordered.filter((path) => existsSync(path)));
  if ((process.platform === "darwin" || process.platform === "linux") && present.size > 0) {
    try {
      const manager = createRuntimeServiceManager({
        homeDir,
        platform: process.platform,
      });
      await manager.uninstall();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`停止开机服务失败：${message}`);
    }
  }
  const removed: string[] = [];
  for (const path of ordered) {
    if (!present.has(path)) continue;
    if (existsSync(path)) await rm(path, { force: true });
    removed.push(path);
  }
  return removed;
}

function managedStatePath(): string {
  return join(runtimePaths().dataDir, "managed-blocks.json");
}

function parseClients(ids: string[]): SessionSource[] {
  const known = new Set<string>(SESSION_SOURCES);
  for (const id of ids) {
    if (!known.has(id)) throw new CliError(`未知客户端：${id}`);
  }
  return ids as SessionSource[];
}

function line(item: IntegrationPlanItem): string {
  const where = item.path ? ` ${item.path}` : "";
  const warning = item.warning ? `（${item.warning}）` : "";
  return `${item.id}  ${item.action}${where}${warning}`;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new CliError(`当前不是交互终端，无法确认：${question}。请加上 --yes。`);
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim();
    return answer === "y" || answer === "Y" || answer === "yes" || answer === "是";
  } finally {
    rl.close();
  }
}
