import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { isProcessAlive } from "@you-brain/core/http";
import {
  applyClientIntegrations,
  planClientIntegrations,
  planClientUninstall,
  type IntegrationPlanItem,
} from "@you-brain/core/clients";
import { restoreBrainHubMigration } from "@you-brain/core/migrate";
import type { SessionSource } from "@you-brain/core";
import { SESSION_SOURCES } from "@you-brain/core";

import { CliError, runtimePaths } from "./env.js";

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
  console.log(`完成 ${result.applied.length} 项，跳过 ${result.skipped.length} 项`);
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
  const candidates = [
    join(homeDir, "Library", "LaunchAgents", "com.you-brain.daemon.plist"),
    join(homeDir, ".config", "systemd", "user", "you-brain.service"),
  ];
  const removed: string[] = [];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    await rm(path, { force: true });
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
