#!/usr/bin/env bun
import "@you-brain/core/native";
import { readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Database } from "bun:sqlite";
import { Command } from "commander";
import {
  createDefaultRoles,
  createDefaultSharedConfig,
  parseRoles,
  parseSharedConfig,
} from "@you-brain/protocol";
import { YouBrainError, loadLocalConfig } from "@you-brain/core";
import { openGoogleDrive, resolveWebDir, startDaemon } from "@you-brain/core/daemon";
import { checkNativeModules } from "@you-brain/core/native";
import type { DrivePort } from "@you-brain/core/drive";
import type {
  StatusResponse,
  TodayResponse,
  TopicDetail,
  TopicListItem,
} from "@you-brain/core/http";
import { createLocalMcpServices, serveMcp } from "@you-brain/core/mcp";
import { SearchService, type Embedder } from "@you-brain/core/search";
import { SqliteStore } from "@you-brain/core/store";

import {
  CliError,
  connectDaemon,
  fail,
  printOfflineStatus,
  runtimePaths,
  supportedPlatform,
} from "./env.js";
import { applyIntegrations, listIntegrations, restoreBrainHub, uninstall } from "./maintenance.js";
import { runSetup, type SetupFlags } from "./setup.js";

function cliVersion(): string {
  try {
    const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    if (typeof packageJson.version === "string" && packageJson.version.length > 0) {
      return packageJson.version;
    }
  } catch {
    // A compiled binary stores this file outside /$bunfs.
  }
  return "0.1.0";
}

const program = new Command();
program.name("you-brain").description("本地 AI 会话大脑").version(cliVersion());

program
  .command("daemon")
  .description("前台运行 daemon")
  .action(async () => {
    try {
      const platform = supportedPlatform();
      const webDir = await resolveWebDir({
        env: process.env,
        execPath: process.execPath,
        moduleUrl: import.meta.url,
        cwd: process.cwd(),
      });
      const daemon = await startDaemon({
        signals: true,
        platform,
        homeDir: homedir(),
        env: process.env,
        ...(webDir ? { staticDir: webDir } : {}),
      });
      console.log(`you-brain daemon 正在监听 ${daemon.baseUrl}`);
      // Scan abort is what makes shutdown prompt. This only covers a flush that never returns.
      let forceExit: ReturnType<typeof setTimeout> | null = null;
      const armForceExit = (): void => {
        forceExit ??= setTimeout(() => {
          process.exit(0);
        }, 8_000);
      };
      process.on("SIGINT", armForceExit);
      process.on("SIGTERM", armForceExit);
      await daemon.closed;
      if (forceExit) clearTimeout(forceExit);
    } catch (error) {
      fail(error);
    }
  });

program
  .command("native-check")
  .description("检查编译产物里的 sharp 与嵌入模型")
  .action(async () => {
    try {
      const cache = process.env.YOU_BRAIN_MODEL_CACHE ?? runtimePaths().modelCacheDir;
      const result = await checkNativeModules(cache);
      console.log(JSON.stringify(result));
      if (!result.ok) process.exit(1);
    } catch (error) {
      fail(error);
    }
  });

program
  .command("mcp")
  .description("对本地 daemon 数据提供 MCP 服务")
  .action(async () => {
    try {
      await serveLocalMcp();
    } catch (error) {
      fail(error);
    }
  });

program
  .command("setup")
  .description("分步设置，可重复执行并跳过已完成的步骤")
  .option("--yes", "非交互，接受默认值")
  .option("--oauth <mode>", "official 或 custom")
  .option("--client-id <id>", "自带 OAuth client id")
  .option("--client-secret <secret>", "自带 OAuth client secret")
  .option("--drive-root <name>", "Drive 根目录名称")
  .option("--inherit-brainhub", "接管 BrainHub 配置、定时任务和 MCP")
  .option("--skip-brainhub", "不接管 BrainHub")
  .option("--provider <provider>", "模型 Provider")
  .option("--model <model>", "模型名")
  .option("--api-key <key>", "模型 API Key，写入钥匙串")
  .option("--base-url <url>", "模型接口地址")
  .option("--source <id=path>", "采集来源，可重复", collect, [])
  .option("--integrations <ids>", "逗号分隔的客户端 id")
  .option("--backfill", "确认首次回填")
  .option("--no-backfill", "跳过首次回填")
  .option("--display-name <name>", "设备显示名")
  .action(async (opts: SetupCommandOptions) => {
    try {
      await runSetup(setupFlags(opts));
    } catch (error) {
      fail(error);
    }
  });

program
  .command("status")
  .description("查看 daemon 状态；未运行时读取本地库")
  .action(async () => {
    try {
      const client = await connectDaemon();
      printStatus(await client.status());
    } catch (error) {
      if (error instanceof CliError) {
        await printOfflineStatus();
        return;
      }
      fail(error);
    }
  });

program
  .command("today")
  .description("今天的会话")
  .action(async () => {
    try {
      printToday(await (await connectDaemon()).today());
    } catch (error) {
      fail(error);
    }
  });

program
  .command("topics")
  .description("话题列表")
  .option("--history", "同时列出历史话题")
  .action(async (opts: { history?: boolean }) => {
    try {
      const client = await connectDaemon();
      const active = await client.topics({ zone: "active" });
      console.log("活跃话题");
      printTopicList(active.topics);
      if (opts.history) {
        const history = await client.topics({ zone: "history" });
        console.log("历史话题");
        printTopicList(history.topics);
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command("topic")
  .description("话题详情")
  .argument("<id>", "话题 id")
  .action(async (id: string) => {
    try {
      printTopic(await (await connectDaemon()).topic(id));
    } catch (error) {
      fail(error);
    }
  });

program
  .command("portrait")
  .description("数字分身")
  .option("--variant <variant>", "full、brief 或 coding")
  .action(async (opts: { variant?: string }) => {
    try {
      const portrait = await (await connectDaemon()).portrait(opts.variant);
      console.log(portrait.content);
    } catch (error) {
      fail(error);
    }
  });

program
  .command("devices")
  .description("设备列表")
  .option("--set-main <id>", "设为主设备")
  .option("--set-web-processor <id>", "设为 Web 会话处理设备")
  .action(async (opts: { setMain?: string; setWebProcessor?: string }) => {
    try {
      const client = await connectDaemon();
      if (opts.setMain || opts.setWebProcessor) {
        const roles = await client.updateRoles({
          ...(opts.setMain ? { mainDevice: opts.setMain } : {}),
          ...(opts.setWebProcessor ? { webProcessor: opts.setWebProcessor } : {}),
        });
        console.log(`主设备：${roles.mainDevice ?? "未设置"}`);
        console.log(`Web 处理设备：${roles.webProcessor ?? "未设置"}`);
      }
      const { devices } = await client.devices();
      if (devices.length === 0) {
        console.log("还没有设备。");
        return;
      }
      for (const device of devices) {
        console.log(`- ${device.displayName}  ${device.deviceId}  ${device.platform}`);
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command("sync")
  .description("查看或立即拉取同步")
  .option("--now", "立即拉取")
  .action(async (opts: { now?: boolean }) => {
    try {
      const client = await connectDaemon();
      if (!opts.now) {
        const status = await client.status();
        console.log(
          status.sync.lastSyncAt
            ? `上次同步：${status.sync.lastSyncAt}`
            : "尚未同步。使用 you-brain sync --now 立即拉取。",
        );
        return;
      }
      const result = await client.sync();
      console.log(result.started ? `已开始同步 ${result.at}` : `未连接 Drive，未同步 ${result.at}`);
    } catch (error) {
      fail(error);
    }
  });

program
  .command("integrations")
  .description("列出、应用或撤销 MCP、CLI 注入和 skill")
  .argument("[action]", "list、apply 或 revoke", "list")
  .option("--yes", "逐项默认确认")
  .option("--only <ids>", "逗号分隔的客户端 id")
  .action(async (action: string, opts: { yes?: boolean; only?: string }) => {
    try {
      const only = opts.only?.split(",").map((item) => item.trim()).filter(Boolean);
      if (action === "list") {
        await listIntegrations(only);
        return;
      }
      if (action === "apply" || action === "revoke") {
        await applyIntegrations({
          yes: Boolean(opts.yes),
          intent: action === "revoke" ? "uninstall" : "install",
          ...(only ? { only } : {}),
        });
        return;
      }
      throw new CliError("integrations 的动作只能是 list、apply 或 revoke");
    } catch (error) {
      fail(error);
    }
  });

const brainhub = program.command("brainhub").description("BrainHub 迁移");
brainhub
  .command("restore")
  .description("从备份恢复 BrainHub 配置")
  .requiredOption("--backup <dir>", "备份目录")
  .action(async (opts: { backup: string }) => {
    try {
      await restoreBrainHub(opts.backup);
    } catch (error) {
      fail(error);
    }
  });

program
  .command("uninstall")
  .description("撤销接入、开机项，可选删除本地数据")
  .option("--yes", "不逐项确认")
  .option("--delete-data", "删除本地数据库和输出目录")
  .action(async (opts: { yes?: boolean; deleteData?: boolean }) => {
    try {
      await uninstall({ yes: Boolean(opts.yes), deleteData: Boolean(opts.deleteData) });
    } catch (error) {
      fail(error);
    }
  });

interface SetupCommandOptions {
  yes?: boolean;
  oauth?: string;
  clientId?: string;
  clientSecret?: string;
  driveRoot?: string;
  inheritBrainhub?: boolean;
  skipBrainhub?: boolean;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  source?: string[];
  integrations?: string;
  backfill?: boolean;
  displayName?: string;
}

function setupFlags(opts: SetupCommandOptions): SetupFlags {
  const argv = process.argv;
  const backfill = argv.includes("--no-backfill")
    ? false
    : argv.includes("--backfill")
      ? true
      : undefined;
  return {
    yes: Boolean(opts.yes),
    inheritBrainhub: Boolean(opts.inheritBrainhub),
    skipBrainhub: Boolean(opts.skipBrainhub),
    sources: opts.source ?? [],
    ...(opts.oauth ? { oauth: opts.oauth } : {}),
    ...(opts.clientId ? { clientId: opts.clientId } : {}),
    ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
    ...(opts.driveRoot ? { driveRoot: opts.driveRoot } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.integrations !== undefined ? { integrations: opts.integrations } : {}),
    ...(backfill !== undefined ? { backfill } : {}),
    ...(opts.displayName ? { displayName: opts.displayName } : {}),
  };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function printStatus(status: StatusResponse): void {
  console.log(`设备：${status.deviceId ?? "未知"}`);
  const account = status.drive.accountEmail ? `（${status.drive.accountEmail}）` : "";
  console.log(`Drive：${status.drive.reachable ? "可达" : "不可达"}${account}`);
  console.log(
    `同步：${status.sync.lastSyncAt ?? "尚未同步"}，待发送 ${status.sync.pendingOutbox}`,
  );
  console.log(`搜索：${status.search.documents} 篇${status.search.ready ? "" : "（索引未就绪）"}`);
  console.log(
    `提炼队列：${status.refine.pending}${status.refine.lastError ? `，最近错误：${status.refine.lastError}` : ""}`,
  );
  const consolidation =
    status.consolidation.status === "disabled"
      ? "未启用"
      : status.consolidation.status === "stale"
        ? "超过 1 天未沉淀"
        : (status.consolidation.lastFinishedAt ?? "尚未沉淀");
  console.log(`沉淀：${consolidation}`);
  for (const warning of status.warnings) console.log(`提示：${warning.message}`);
}

function printToday(today: TodayResponse): void {
  if (today.sessions.length === 0) {
    console.log("今天还没有会话");
    return;
  }
  console.log(`${today.date}（${today.timeZone}）`);
  for (const session of today.sessions) {
    console.log(`- ${session.title || "未命名"} [${session.source}]`);
    if (session.summary) console.log(`  ${session.summary}`);
    if (session.topicName) console.log(`  话题：${session.topicName}`);
  }
}

function printTopicList(topics: TopicListItem[]): void {
  if (topics.length === 0) {
    console.log("（无）");
    return;
  }
  for (const topic of topics) {
    console.log(`- ${topic.name}  ${topic.topicId}  ${topic.status}`);
    if (topic.summary) console.log(`  ${topic.summary}`);
  }
}

function printTopic(topic: TopicDetail): void {
  console.log(`${topic.name}  ${topic.zone}  ${topic.status}`);
  if (topic.summary) console.log(topic.summary);
  if (topic.nextStep) console.log(`下一步：${topic.nextStep}`);
  if (topic.sessions.length === 0) console.log("没有关联会话");
  for (const session of topic.sessions) {
    console.log(`- ${session.title || session.sessionKey} [${session.source}]`);
  }
}

async function serveLocalMcp(): Promise<void> {
  const platform = supportedPlatform();
  const paths = runtimePaths();
  const loaded = await loadLocalConfig({
    homeDir: homedir(),
    platform,
    env: process.env,
  });
  const opened = await openGoogleDrive({
    local: loaded.config,
    configFile: loaded.configFile,
    platform,
    interactive: false,
  });
  const drive = opened?.drive ?? unavailableDrive();
  const shared = await readConfig(join(paths.dataDir, "shared.json"), createDefaultSharedConfig(), parseSharedConfig);
  const roles = await readConfig(join(paths.dataDir, "roles.json"), createDefaultRoles(), parseRoles);
  const database = new Database(paths.stateFile, { create: true });
  database.exec("PRAGMA busy_timeout = 5000");
  const store = new SqliteStore(paths.stateFile);
  const search = new SearchService({
    drive: {
      changes: (query) => drive.changes(query),
      async read(id: string) {
        const object = await drive.read(id);
        return { bytes: object.bytes };
      },
    },
    embedder: quietEmbedder,
    database,
  });
  await serveMcp(
    createLocalMcpServices({
      store,
      search,
      drive,
      portraitDir: paths.portraitDir,
      dataDir: paths.dataDir,
      zone: {
        timeZone: roles.timezone,
        activeLimit: shared.topics.activeLimit,
        historyDays: shared.topics.historyDays,
      },
    }),
  );
}

const quietEmbedder: Embedder = {
  model: "local",
  revision: "0",
  dimensions: 384,
  embedQuery() {
    return Promise.reject(new Error("搜索索引由 daemon 刷新"));
  },
  embedPassages() {
    return Promise.reject(new Error("搜索索引由 daemon 刷新"));
  },
};

function unavailableDrive(): DrivePort {
  const fail = (): Promise<never> =>
    Promise.reject(new YouBrainError("AUTH_REQUIRED", "尚未登录 Google Drive，无法读取会话原文"));
  return {
    list: fail,
    changes: fail,
    startPageToken: fail,
    create: fail,
    put: fail,
    update: fail,
    upsert: fail,
    read: fail,
    readPath: fail,
    findByPath: fail,
    findByAppProperty: fail,
    ensureFolder: fail,
    rename: fail,
    move: fail,
    trash: fail,
    quota: fail,
  };
}

async function readConfig<T>(path: string, fallback: T, parse: (input: unknown) => T): Promise<T> {
  if (!existsSync(path)) return fallback;
  return parse(JSON.parse(await readFile(path, "utf8")) as unknown);
}

const TOP_COMMANDS = new Set([
  "daemon",
  "native-check",
  "mcp",
  "setup",
  "status",
  "today",
  "topics",
  "integrations",
  "brainhub",
  "uninstall",
]);

/** First real subcommand. A compiled binary's argv includes the bunfs entry path. */
function invokedCommand(): string | undefined {
  return process.argv.find((arg) => TOP_COMMANDS.has(arg));
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  fail(error);
}
// Bun 的 fetch 会保持到 daemon 的连接（服务端 idleTimeout 为 0），
// 查询命令打完日志后进程不会自己退出。
// mcp 要一直占住 stdin。这里退出会在 initialize 写出之前把进程杀掉。
if (invokedCommand() !== "mcp") {
  process.exit(0);
}
