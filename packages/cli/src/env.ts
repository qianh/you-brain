import { existsSync } from "node:fs";
import { homedir } from "node:os";

import {
  assertSupportedPlatform,
  loadLocalConfig,
  platformPaths,
  type YouBrainPaths,
} from "@you-brain/core";
import { SqliteStore } from "@you-brain/core/store";
import {
  createDaemonClient,
  isProcessAlive,
  readDaemonEndpoint,
  type DaemonClient,
} from "@you-brain/core/http";

export const DAEMON_DOWN =
  "you-brain daemon 没有在运行。请先执行：you-brain daemon";

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export function runtimePaths(): YouBrainPaths {
  const platform = process.platform;
  assertSupportedPlatform(platform);
  return platformPaths({
    platform,
    homeDir: homedir(),
    env: process.env,
  });
}

export function supportedPlatform(): "darwin" | "linux" {
  const platform = process.platform;
  assertSupportedPlatform(platform);
  if (platform !== "darwin" && platform !== "linux") {
    throw new CliError("you-brain 只支持 macOS 和 Linux");
  }
  return platform;
}

export async function connectDaemon(): Promise<DaemonClient> {
  const paths = runtimePaths();
  try {
    const endpoint = await readDaemonEndpoint(paths.dataDir);
    if (!endpoint || !isProcessAlive(endpoint.pid)) throw new CliError(DAEMON_DOWN);
    return createDaemonClient({ port: endpoint.port, token: endpoint.token });
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(DAEMON_DOWN);
  }
}

/** Local status when the daemon is down. Does not create a database. */
export async function printOfflineStatus(): Promise<void> {
  const paths = runtimePaths();
  const platform = supportedPlatform();
  console.log("you-brain daemon 没有在运行。");
  console.log(`数据目录：${paths.dataDir}`);
  if (!existsSync(paths.configFile)) {
    console.log("设备：尚未初始化。可执行 you-brain setup");
  } else {
    const loaded = await loadLocalConfig({
      homeDir: homedir(),
      platform,
      env: process.env,
    });
    console.log(`设备：${loaded.config.deviceId}（${loaded.config.displayName}）`);
  }
  if (!existsSync(paths.stateFile)) {
    console.log("本地数据库尚未创建。");
    return;
  }
  const store = new SqliteStore(paths.stateFile);
  try {
    console.log(`会话：${store.listSessions().length}`);
    console.log(`待发送：${store.countOutbox()}`);
  } finally {
    store.close();
  }
}

export function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
