import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { join } from "node:path";

import {
  LLM_PROVIDERS,
  DRIVE_PATHS,
  createDefaultSharedConfig,
  parseSharedConfig,
  type LlmProvider,
  type SharedConfig,
} from "@you-brain/protocol";
import {
  SESSION_SOURCES,
  createDefaultLocalConfig,
  loadLocalConfig,
  writeLocalConfig,
  type DeviceRole,
  type LocalConfig,
  type SessionSource,
  type YouBrainPaths,
} from "@you-brain/core";
import {
  GOOGLE_CLIENT_ID_SUFFIX,
  MISSING_OFFICIAL_OAUTH_MESSAGE,
  createOAuthClientSecretStore,
  isGoogleClientId,
  isUsableOfficialOAuthClient,
  resolveOfficialOAuthClient,
  resolveSecretBackend,
  setLlmApiKey,
  type SecretBackend,
} from "@you-brain/core/auth";
import { captureSourceFilters, discoverSessions, getAdapter } from "@you-brain/core/adapters";
import {
  applyClientIntegrations,
  planClientIntegrations,
  type IntegrationPlanItem,
} from "@you-brain/core/clients";
import { openGoogleDrive, type OpenGoogleDriveOptions } from "@you-brain/core/daemon";
import type { DrivePort } from "@you-brain/core/drive";
import {
  createLlmBackend,
  LLM_PRESETS,
  cliCommandName,
  cliLoginCommand,
  cliNoResponseMessage,
  formatUnusableCli,
  isCliNoOutputTimeout,
  isCliProvider,
  isLlmRequestError,
  locateRunnableCli,
} from "@you-brain/core/llm";
import {
  applyBrainHubDefaults,
  applyBrainHubMigration,
  planBrainHubMigration,
  type BrainHubMigrationPlan,
  type MigrateContext,
} from "@you-brain/core/migrate";
import {
  FilePortraitConsentStore,
  grantIntegrationConsent,
  portraitConsentPath,
} from "@you-brain/core/portrait";
import { SqliteStore } from "@you-brain/core/store";
import { upsertByPath } from "@you-brain/core/upload";

import { CliError, runtimePaths, supportedPlatform } from "./env.js";

export interface SetupFlags {
  yes: boolean;
  oauth?: string;
  clientId?: string;
  clientSecret?: string;
  driveRoot?: string;
  inheritBrainhub: boolean;
  skipBrainhub: boolean;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  sources: string[];
  integrations?: string;
  /** `--no-integrations`：一项都不写入，也不记录授权。 */
  skipIntegrations?: boolean;
  /** Undefined asks, unless --yes which backfills. */
  backfill?: boolean;
  displayName?: string;
  /** `--server`：无界面常开主设备。 */
  role?: DeviceRole;
}

export interface SetupHooks {
  ask?: (question: string, fallback: string) => Promise<string>;
  log?: (message: string) => void;
  isTTY?: boolean;
  hasOfficialOAuth?: () => boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  paths?: YouBrainPaths;
  platform?: "darwin" | "linux";
  openGoogleDrive?: (
    options: OpenGoogleDriveOptions,
  ) => ReturnType<typeof openGoogleDrive>;
  planBrainHubMigration?: (context: MigrateContext) => Promise<BrainHubMigrationPlan>;
  applyBrainHubMigration?: typeof applyBrainHubMigration;
  /** Test injection. CLI connection tests otherwise wait 90 seconds. */
  cliTimeoutMs?: number;
  /** 覆盖密钥后端推断（服务器上用文件后端）。 */
  secretBackend?: SecretBackend;
}

interface SetupIo {
  ask: (question: string, fallback: string) => Promise<string>;
  log: (message: string) => void;
  isTTY: boolean;
  hasOfficialOAuth: () => boolean;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  paths: YouBrainPaths;
  platform: "darwin" | "linux";
  openGoogleDrive: (
    options: OpenGoogleDriveOptions,
  ) => ReturnType<typeof openGoogleDrive>;
  planBrainHubMigration: (context: MigrateContext) => Promise<BrainHubMigrationPlan>;
  applyBrainHubMigration: typeof applyBrainHubMigration;
  cliTimeoutMs?: number;
  secretBackend: SecretBackend;
}

const CLI_SETUP_TIMEOUT_MS = 90_000;

function isCliConnectionTimeout(error: unknown): boolean {
  if (isCliNoOutputTimeout(error)) return true;
  return isLlmRequestError(error) && error.kind === "network" && error.message.includes("请求超时");
}

interface SetupProgress {
  version: 1;
  google: boolean;
  drive: boolean;
  brainhub: boolean;
  model: boolean;
  sources: boolean;
  integrations: boolean;
  backfill: boolean;
}

const EMPTY_PROGRESS: SetupProgress = {
  version: 1,
  google: false,
  drive: false,
  brainhub: false,
  model: false,
  sources: false,
  integrations: false,
  backfill: false,
};

export async function runSetup(flags: SetupFlags, hooks: SetupHooks = {}): Promise<void> {
  const io = createIo(hooks);
  const paths = io.paths;
  const homeDir = io.homeDir;
  await mkdir(paths.dataDir, { recursive: true });
  const progress = await readProgress(join(paths.dataDir, "setup.json"));
  const context: MigrateContext = {
    homeDir,
    platform: io.platform,
    env: io.env,
  };
  const migration = await io.planBrainHubMigration(context);
  let config: LocalConfig;
  let drive: DrivePort | null = null;
  let createdConfig = false;

  // Ask before login. Disabling BrainHub waits until Google login succeeds.
  const inherit = progress.brainhub
    ? false
    : await decideInherit(flags, migration.detected, false, io);
  const pendingTakeover = !progress.brainhub && inherit && migration.items.length > 0;

  if (!existsSync(paths.configFile)) {
    createdConfig = true;
    const defaults = inherit ? migration.defaults : {};
    config = applyBrainHubDefaults(
      createDefaultLocalConfig({
        hostname: flags.displayName ?? hostname(),
        dataDir: paths.dataDir,
        role: flags.role ?? "desktop",
        ...(defaults.deviceId ? { deviceId: defaults.deviceId } : {}),
        ...(defaults.displayName && !flags.displayName
          ? { displayName: defaults.displayName }
          : {}),
        ...(flags.displayName ? { displayName: flags.displayName } : {}),
        ...(defaults.driveRoot ? { driveRoot: defaults.driveRoot } : {}),
        ...(flags.driveRoot ? { driveRoot: flags.driveRoot } : {}),
      }),
      defaults,
    );
    if (flags.driveRoot) config = { ...config, driveRoot: flags.driveRoot };
    if (flags.displayName) config = { ...config, displayName: flags.displayName };
    await writeLocalConfig(paths.configFile, config);
  } else {
    config = (
      await loadLocalConfig({
        homeDir,
        platform: io.platform,
        env: io.env,
        configFile: paths.configFile,
      })
    ).config;
    // 角色是这台机器自己的设置，重复跑 setup 时允许显式切换。
    if (flags.role && config.role !== flags.role) {
      config = { ...config, role: flags.role };
      await writeLocalConfig(paths.configFile, config);
    }
  }
  // 角色确定后才能推断密钥后端：服务器默认写文件，不依赖桌面会话的钥匙串。
  if (hooks.secretBackend === undefined && config.role === "server") {
    io.secretBackend = resolveSecretBackend({
      env: io.env,
      dataDir: paths.dataDir,
      role: config.role,
    });
  }
  if (!progress.brainhub && !pendingTakeover) {
    progress.brainhub = true;
    await saveProgress(paths.dataDir, progress);
  } else if (pendingTakeover) {
    io.log("将在 Google 登录成功后接管 BrainHub。");
  }

  let loggedIn = hasGoogleLogin(config);
  // Takeover waits for a successful login, including when an earlier --yes
  // marked the Google step done without actually signing in.
  const retryForTakeover = pendingTakeover && !loggedIn;
  if (!progress.google || flags.oauth || flags.clientId || flags.clientSecret || retryForTakeover) {
    config = await configureGoogle(flags, config, paths.configFile, io.platform, io);
    let opened: Awaited<ReturnType<typeof openGoogleDrive>>;
    try {
      opened = await io.openGoogleDrive({
        local: config,
        configFile: paths.configFile,
        platform: io.platform,
        interactive: !flags.yes,
        env: io.env,
        secretBackend: io.secretBackend,
        ...(config.role === "server" ? { headless: {} } : {}),
        ...(flags.clientSecret ? { clientSecret: flags.clientSecret } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google 登录未完成";
      throw new CliError(message);
    }
    if (opened) {
      config = opened.config;
      drive = opened.drive;
      loggedIn = true;
      io.log(`已登录 Google Drive${config.account.email ? `（${config.account.email}）` : ""}`);
    } else if (flags.yes) {
      io.log("尚未登录 Google Drive。daemon 仍可启动，登录后会继续同步。");
    } else {
      throw new CliError("Google 登录未完成");
    }
    progress.google = true;
    await saveProgress(paths.dataDir, progress);
  }

  if (pendingTakeover) {
    if (!loggedIn) {
      io.log("Google 尚未登录，暂不接管 BrainHub。");
    } else {
      const backupDir = join(paths.dataDir, "migrate", String(Date.now()));
      const applied = await io.applyBrainHubMigration({
        context,
        plan: migration,
        selectedIds: migration.items.map((item) => item.id),
        backupDir,
      });
      io.log(
        createdConfig
          ? `已接管 BrainHub，备份在 ${applied.backupDir}`
          : `已移除 BrainHub 定时任务与 MCP 条目，备份在 ${applied.backupDir}`,
      );
      progress.brainhub = true;
      await saveProgress(paths.dataDir, progress);
    }
  }

  if (!progress.drive || flags.driveRoot) {
    if (flags.driveRoot) {
      config = { ...config, driveRoot: flags.driveRoot };
      await writeLocalConfig(paths.configFile, config);
    } else if (!flags.yes && io.isTTY) {
      const answer = await io.ask(`Drive 根目录名称 [${config.driveRoot}]：`, config.driveRoot);
      if (answer && answer !== config.driveRoot) {
        config = { ...config, driveRoot: answer };
        await writeLocalConfig(paths.configFile, config);
      }
    }
    io.log(`Drive 根目录：${config.driveRoot}`);
    progress.drive = true;
    await saveProgress(paths.dataDir, progress);
  }

  let shared = await readShared(join(paths.dataDir, "shared.json"));
  if (flags.driveRoot) {
    shared = parseSharedConfig({ ...shared, drive: { root: flags.driveRoot } });
  }

  if (!progress.model || flags.provider || flags.model || flags.apiKey || flags.baseUrl) {
    shared = await configureModel(flags, shared, io);
    await saveShared(paths.dataDir, shared, drive);
    progress.model = true;
    await saveProgress(paths.dataDir, progress);
  }

  if (!progress.sources || flags.sources.length > 0) {
    if (config.role === "server") {
      // 服务器上没有 CLI 会话可采集，全部关掉，避免扫描空转。
      shared = disableAllSources(shared);
      await saveShared(paths.dataDir, shared, drive);
      io.log("服务器模式：不采集本机会话（采集来源全部关闭）。");
    } else {
      shared = await configureSources(flags, shared, homeDir, io);
      await saveShared(paths.dataDir, shared, drive);
    }
    progress.sources = true;
    await saveProgress(paths.dataDir, progress);
  }

  if (!progress.integrations || flags.integrations !== undefined) {
    if (config.role === "server") {
      io.log("服务器模式：跳过 AI 客户端接入。");
    } else {
      await configureIntegrations(
        flags,
        homeDir,
        join(paths.dataDir, "managed-blocks.json"),
        shared,
        paths.dataDir,
        io,
      );
    }
    progress.integrations = true;
    await saveProgress(paths.dataDir, progress);
  }

  if (!progress.backfill || flags.backfill !== undefined) {
    if (config.role === "server") {
      io.log("服务器模式：跳过首次回填（本机没有会话）。");
    } else {
      await configureBackfill(flags, shared, config.displayName, paths.stateFile, io);
    }
    progress.backfill = true;
    await saveProgress(paths.dataDir, progress);
  }

  io.log(
    config.role === "server"
      ? "设置完成。下一步：you-brain service install（开机自启）"
      : "设置完成。下一步：you-brain daemon",
  );
}

function disableAllSources(shared: SharedConfig): SharedConfig {
  const sources = structuredClone(shared.capture.sources);
  for (const id of SESSION_SOURCES) {
    sources[id] = { ...sources[id], enabled: false, paths: [] };
  }
  return parseSharedConfig({ ...shared, capture: { ...shared.capture, sources } });
}

function createIo(hooks: SetupHooks): SetupIo {
  const env = hooks.env ?? process.env;
  return {
    ask: hooks.ask ?? defaultAsk,
    log: hooks.log ?? ((message: string) => console.log(message)),
    isTTY: hooks.isTTY ?? Boolean(process.stdin.isTTY),
    hasOfficialOAuth:
      hooks.hasOfficialOAuth ??
      (() => isUsableOfficialOAuthClient(resolveOfficialOAuthClient(env))),
    env,
    homeDir: hooks.homeDir ?? homedir(),
    paths: hooks.paths ?? runtimePaths(),
    platform: hooks.platform ?? supportedPlatform(),
    openGoogleDrive: hooks.openGoogleDrive ?? openGoogleDrive,
    planBrainHubMigration: hooks.planBrainHubMigration ?? planBrainHubMigration,
    applyBrainHubMigration: hooks.applyBrainHubMigration ?? applyBrainHubMigration,
    ...(hooks.cliTimeoutMs === undefined ? {} : { cliTimeoutMs: hooks.cliTimeoutMs }),
    secretBackend:
      hooks.secretBackend ?? resolveSecretBackend({ env, dataDir: (hooks.paths ?? runtimePaths()).dataDir }),
  };
}

function hasGoogleLogin(config: LocalConfig): boolean {
  return config.account.email.trim() !== "" || config.driveRootId.trim() !== "";
}

async function decideInherit(
  flags: SetupFlags,
  detected: boolean,
  alreadyDone: boolean,
  io: SetupIo,
): Promise<boolean> {
  if (flags.skipBrainhub) return false;
  if (flags.inheritBrainhub) return true;
  if (alreadyDone || !detected) return false;
  if (flags.yes) {
    io.log("检测到 BrainHub。未接管。需要接管时加上 --inherit-brainhub。");
    return false;
  }
  requireTty("是否接管 BrainHub", io);
  return confirm("检测到 BrainHub。接管配置、定时任务和 MCP 条目？", false, io);
}

async function configureGoogle(
  flags: SetupFlags,
  config: LocalConfig,
  configFile: string,
  platform: "darwin" | "linux",
  io: SetupIo,
): Promise<LocalConfig> {
  const officialReady = io.hasOfficialOAuth();
  let mode = flags.oauth ?? config.oauth.mode;
  if (!flags.oauth && !flags.yes) {
    requireTty("Google 登录方式", io);
    for (;;) {
      const answer = await io.ask(oauthModeQuestion(officialReady), officialReady ? "1" : "2");
      mode = answer === "2" ? "custom" : "official";
      if (mode === "official" && !officialReady) {
        io.log(MISSING_OFFICIAL_OAUTH_MESSAGE);
        continue;
      }
      break;
    }
  } else if (flags.oauth === "official" && !officialReady) {
    throw new CliError(MISSING_OFFICIAL_OAUTH_MESSAGE);
  } else if (!flags.oauth && flags.yes && !officialReady && !flags.clientId) {
    // --yes 且未内置官方凭据：不登录也能先把服务装起来，稍后在界面里配自带凭据。
    io.log(
      `${MISSING_OFFICIAL_OAUTH_MESSAGE}\n` +
        "先跳过登录；之后在设置页「账户与 Drive → OAuth 凭据」里填自己的项目，" +
        "或重跑：you-brain setup --oauth custom --client-id <id> --client-secret <secret>",
    );
  }
  if (mode !== "official" && mode !== "custom") {
    throw new CliError("oauth 只能是 official 或 custom");
  }
  let clientId = flags.clientId ?? config.oauth.clientId;
  if (mode === "custom" && !clientId) {
    if (flags.yes) throw new CliError("自带凭据需要 --client-id 和 --client-secret");
    requireTty("OAuth client id", io);
    clientId = await io.ask("OAuth client id：", "");
  }
  if (mode === "custom" && !isGoogleClientId(clientId)) {
    throw new CliError(
      `OAuth client id 必须以 ${GOOGLE_CLIENT_ID_SUFFIX} 结尾，收到 ${clientId || "（空）"}`,
    );
  }
  if (mode === "custom" && flags.clientSecret) {
    await createOAuthClientSecretStore({
      platform,
      configFile,
      backend: io.secretBackend,
    }).set(flags.clientSecret);
  } else if (mode === "custom" && !flags.yes) {
    requireTty("OAuth client secret", io);
    const secret = await io.ask("OAuth client secret：", "");
    if (secret) {
      await createOAuthClientSecretStore({
        platform,
        configFile,
        backend: io.secretBackend,
      }).set(secret);
    }
  }
  const next: LocalConfig = {
    ...config,
    oauth: { mode, clientId: mode === "official" ? "" : clientId },
  };
  await writeLocalConfig(configFile, next);
  return next;
}

/**
 * 自带凭据是给多人分发的主路径，所以把在 GCP 里要做的事写在提示里。
 * 关键点是 User type 选 Internal（有 Workspace）或发布到 Production，
 * 否则 Testing 状态下 refresh token 只有 7 天。
 */
function oauthModeQuestion(officialReady: boolean): string {
  const custom = [
    "自带凭据：在 Google Cloud Console 建一个项目，",
    "启用 Google Drive API，OAuth 客户端类型选「桌面应用」，",
    `把 client id（以 ${GOOGLE_CLIENT_ID_SUFFIX} 结尾）和 client secret 填进来。`,
    "User type 选 Internal（同 Workspace 域名），或把应用发布到 Production；",
    "停留在 Testing 时授权每 7 天过期，需要重新登录。",
  ].join("");
  return [
    "Google 登录方式",
    officialReady ? "  1 官方" : "  1 官方（此构建未内置，不可用）",
    `  2 ${custom}`,
    `[${officialReady ? "1" : "2"}]：`,
  ].join("\n");
}

const API_PROVIDERS = [
  "deepseek",
  "glm",
  "qwen",
  "kimi",
  "openai",
  "claude",
  "ollama",
  "custom",
] as const;

const CLI_PROVIDER_IDS = [
  "grok-cli",
  "claude-cli",
  "codex-cli",
  "gemini-cli",
  "opencode-cli",
] as const;

function providerQuestion(current: string): string {
  return [
    "模型 Provider",
    `  API：${API_PROVIDERS.join(" / ")}`,
    `  本机订阅：${CLI_PROVIDER_IDS.join(" / ")}`,
    `[${current}]：`,
  ].join("\n");
}

async function configureModel(
  flags: SetupFlags,
  shared: SharedConfig,
  io: SetupIo,
): Promise<SharedConfig> {
  let provider = flags.provider ?? (flags.yes ? shared.llm.provider : "");
  if (!provider) {
    requireTty("模型 Provider", io);
    provider = await io.ask(providerQuestion(shared.llm.provider), shared.llm.provider);
  }
  if (!isProvider(provider)) {
    throw new CliError(`未知 Provider：${provider}`);
  }
  const preset = LLM_PRESETS[provider];
  if (preset.kind === "cli") {
    if (!isCliProvider(provider)) throw new CliError(`未知 Provider：${provider}`);
    const located = await locateRunnableCli({ provider, env: io.env, homeDir: io.homeDir });
    if (!located.bin) {
      throw new CliError(
        located.unusable.length > 0
          ? formatUnusableCli(located.unusable)
          : `未找到 ${cliCommandName(provider)} 命令行，请先安装并登录`,
      );
    }
  }
  let model = flags.model ?? (flags.yes ? shared.llm.model : "");
  if (!flags.model && !flags.yes) {
    requireTty("模型名", io);
    model =
      preset.kind === "cli"
        ? await io.ask(
            `模型名（留空用 ${cliCommandName(provider)} 自己的默认模型）[${shared.llm.model}]：`,
            shared.llm.model,
          )
        : await io.ask(`模型名 [${shared.llm.model || "默认"}]：`, shared.llm.model);
  }
  const flaggedBase = flags.baseUrl?.trim() ?? "";
  let baseUrl = flaggedBase !== "" ? flaggedBase : shared.llm.baseUrl;
  if (provider === "custom" && flaggedBase === "" && shared.llm.baseUrl.trim() === "" && !flags.yes) {
    requireTty("Base URL", io);
    baseUrl = await io.ask("Base URL（OpenAI 兼容，如 https://api.x.ai/v1）：", "");
    if (baseUrl.trim() === "") throw new CliError("需要 Base URL");
  }
  let apiKey = flags.apiKey ?? "";
  if (!flags.apiKey && !flags.yes && preset.requiresApiKey) {
    requireTty("API Key", io);
    apiKey = await io.ask("API Key（只存在本机，不会回显）：", "");
    if (!apiKey) throw new CliError("需要 API Key 才能测试模型连接");
  }
  const next = parseSharedConfig({
    ...shared,
    llm: {
      provider,
      model,
      baseUrl,
    },
  });
  if (apiKey)
    await setLlmApiKey(provider, apiKey, {
      platform: io.platform,
      backend: io.secretBackend,
    });
  if (apiKey || !preset.requiresApiKey) {
    const cliTimeoutMs = io.cliTimeoutMs ?? CLI_SETUP_TIMEOUT_MS;
    if (preset.kind === "cli" && isCliProvider(provider)) {
      const seconds = Math.max(1, Math.round(cliTimeoutMs / 1000));
      io.log(`正在调用 ${cliCommandName(provider)} 测试连接（最多 ${seconds} 秒）…`);
    }
    const backend = await createLlmBackend({
      config: next.llm,
      getApiKey: async () => (apiKey === "" ? null : apiKey),
      dataDir: io.paths.dataDir,
      env: io.env,
      homeDir: io.homeDir,
      ...(preset.kind === "cli" ? { timeoutMs: cliTimeoutMs } : {}),
    });
    try {
      await backend.test();
    } catch (error) {
      if (
        preset.kind === "cli" &&
        isCliProvider(provider) &&
        isCliConnectionTimeout(error)
      ) {
        throw new CliError(
          cliNoResponseMessage(cliCommandName(provider), cliTimeoutMs, cliLoginCommand(provider)),
        );
      }
      throw error;
    }
    io.log("模型连接成功");
  } else {
    io.log("未配置模型 API Key。会话仍会上传，提炼会跳过。");
  }
  return next;
}

async function configureSources(
  flags: SetupFlags,
  shared: SharedConfig,
  homeDir: string,
  io: SetupIo,
): Promise<SharedConfig> {
  const sources = structuredClone(shared.capture.sources);
  if (flags.sources.length > 0) {
    for (const raw of flags.sources) {
      const split = raw.indexOf("=");
      if (split <= 0) throw new CliError(`来源格式应为 id=/path，收到 ${raw}`);
      const id = raw.slice(0, split);
      const path = raw.slice(split + 1);
      if (!isSource(id)) throw new CliError(`未知来源：${id}`);
      if (!path) throw new CliError(`来源 ${id} 缺少路径`);
      sources[id] = { ...sources[id], enabled: true, paths: [path] };
    }
  } else if (flags.yes) {
    for (const id of SESSION_SOURCES) {
      const roots = getAdapter(id)?.defaultRoots(homeDir) ?? [];
      sources[id] = { ...sources[id], enabled: true, paths: roots };
    }
  } else {
    requireTty("采集来源", io);
    for (const id of SESSION_SOURCES) {
      const enabled = await confirm(`采集 ${id}？`, true, io);
      if (!enabled) {
        sources[id] = { ...sources[id], enabled: false };
        continue;
      }
      const defaults = (getAdapter(id)?.defaultRoots(homeDir) ?? []).join(",");
      const answer = await io.ask(`  路径（逗号分隔，空则 ${defaults || "默认"}）：`, "");
      const paths = answer
        ? answer.split(",").map((item) => item.trim()).filter(Boolean)
        : (getAdapter(id)?.defaultRoots(homeDir) ?? []);
      sources[id] = { ...sources[id], enabled: true, paths };
    }
  }
  return parseSharedConfig({ ...shared, capture: { ...shared.capture, sources } });
}

async function configureIntegrations(
  flags: SetupFlags,
  homeDir: string,
  managedStatePath: string,
  shared: SharedConfig,
  dataDir: string,
  io: SetupIo,
): Promise<void> {
  const clients = flags.integrations === undefined ? undefined : asSources(flags.integrations);
  const plan = await planClientIntegrations({
    homeDir,
    managedStatePath,
    ...(clients ? { clients } : {}),
  });
  if (plan.items.length === 0) {
    io.log("没有检测到可接入的 AI 工具。");
    return;
  }
  logIntegrationSummary(plan.items, homeDir, io);
  const choice = await resolveIntegrationChoice(flags, io);
  const selected = await selectIntegrationItems(plan.items, choice, io);
  const result = await applyClientIntegrations({
    homeDir,
    plan,
    selectedIds: selected,
    managedStatePath,
  });
  if (selected.length > 0) {
    const codingPath =
      shared.portrait.variants.find((variant) => variant.id === "coding")?.path ??
      "digital-twin/JOHN-TWIN-coding.md";
    await grantIntegrationConsent(
      new FilePortraitConsentStore(portraitConsentPath(dataDir)),
      selected,
      codingPath,
    );
  }
  io.log(`已接入 ${result.applied.length} 项，跳过 ${result.skipped.length} 项`);
}

function logIntegrationSummary(
  items: readonly IntegrationPlanItem[],
  homeDir: string,
  io: SetupIo,
): void {
  io.log("将接入以下 AI 工具：");
  for (const [client, group] of groupIntegrationItems(items)) {
    io.log(`  ${client.padEnd(12)} ${describeClientChanges(group, homeDir)}`);
  }
}

async function resolveIntegrationChoice(
  flags: SetupFlags,
  io: SetupIo,
): Promise<"all" | "none" | "choose"> {
  if (flags.skipIntegrations) return "none";
  if (flags.yes) return "all";
  if (!io.isTTY) {
    if (flags.integrations !== undefined) return "all";
    throw new CliError(
      "当前不是交互终端，无法询问接入。请使用 --yes、--integrations <ids> 或 --no-integrations。",
    );
  }
  return askIntegrationChoice(io);
}

async function askIntegrationChoice(io: SetupIo): Promise<"all" | "none" | "choose"> {
  for (;;) {
    const answer = (await io.ask("接入全部？[Y/n/c] ", "")).trim();
    if (answer === "" || answer === "y" || answer === "Y" || answer === "yes" || answer === "是") {
      return "all";
    }
    if (answer === "n" || answer === "N" || answer === "no" || answer === "否") return "none";
    if (answer === "c" || answer === "C") return "choose";
    io.log("请回答 Y、n 或 c。");
  }
}

async function selectIntegrationItems(
  items: readonly IntegrationPlanItem[],
  choice: "all" | "none" | "choose",
  io: SetupIo,
): Promise<string[]> {
  if (choice === "none") return [];
  const groups = groupIntegrationItems(items);
  if (choice === "all") return groups.flatMap(([, group]) => actionableIds(group));
  const selected: string[] = [];
  for (const [client, group] of groups) {
    const ids = actionableIds(group);
    if (ids.length === 0) continue;
    const accept = await confirm(`接入 ${client}（${ids.length} 项）？`, true, io);
    if (accept) selected.push(...ids);
  }
  return selected;
}

function actionableIds(items: readonly IntegrationPlanItem[]): string[] {
  return items
    .filter((item) => item.action !== "unchanged" && item.action !== "skipped")
    .map((item) => item.id);
}

function groupIntegrationItems(
  items: readonly IntegrationPlanItem[],
): Array<[string, IntegrationPlanItem[]]> {
  const order: string[] = [];
  const grouped = new Map<string, IntegrationPlanItem[]>();
  for (const item of items) {
    const found = grouped.get(item.client);
    if (found) {
      found.push(item);
      continue;
    }
    order.push(item.client);
    grouped.set(item.client, [item]);
  }
  return order.flatMap((client) => {
    const group = grouped.get(client);
    return group ? [[client, group] as [string, IntegrationPlanItem[]]] : [];
  });
}

function describeClientChanges(items: readonly IntegrationPlanItem[], homeDir: string): string {
  const updates: string[] = [];
  const creates: string[] = [];
  const removes: string[] = [];
  const copies: string[] = [];
  const unchanged: string[] = [];
  const skipped: string[] = [];
  let mcp: string | undefined;
  const other: string[] = [];
  for (const item of items) {
    const shown = item.path ? displayPath(item.path, homeDir) : "";
    if (item.action === "unchanged") {
      if (shown) unchanged.push(shown);
      else other.push(`已是最新 ${describeItem(item)}`);
      continue;
    }
    if (item.action === "skipped") {
      if (shown) skipped.push(item.warning ? `${shown}（${item.warning}）` : `${shown} 跳过`);
      else skipped.push(describeItem(item));
      continue;
    }
    if (item.kind === "mcp" && (item.action === "create" || item.action === "update")) {
      mcp = shown ? `注册 MCP ${shown}` : "注册 MCP";
      continue;
    }
    if (item.action === "create" && shown) {
      creates.push(shown);
      continue;
    }
    if (item.action === "update" && shown) {
      updates.push(shown);
      continue;
    }
    if (item.action === "remove" && shown) {
      removes.push(shown);
      continue;
    }
    if (item.action === "copy") {
      copies.push(item.warning ? `画像手动复制（${item.warning}）` : "画像手动复制（不写文件）");
      continue;
    }
    other.push(describeItem(item));
  }
  const changes: string[] = [];
  if (updates.length > 0) changes.push(`修改 ${updates.join("、")}`);
  if (creates.length > 0) changes.push(`新建 ${creates.join("、")}`);
  if (removes.length > 0) changes.push(`删除 ${removes.join("、")}`);
  if (mcp) changes.push(mcp);
  changes.push(...copies, ...other);
  if (unchanged.length > 0) changes.push(`已是最新 ${unchanged.join("、")}`);
  changes.push(...skipped);
  return changes.join("；");
}

function displayPath(path: string, homeDir: string): string {
  const root = homeDir.endsWith("/") ? homeDir.slice(0, -1) : homeDir;
  const prefix = `${root}/`;
  if (path === root) return "~";
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}

async function configureBackfill(
  flags: SetupFlags,
  shared: SharedConfig,
  device: string,
  stateFile: string,
  io: SetupIo,
): Promise<void> {
  const enabled = SESSION_SOURCES.filter((id) => shared.capture.sources[id].enabled);
  const discovered = await discoverSessions({
    device,
    includeSubagents: shared.capture.includeSubagents,
    keepToolCalls: shared.capture.keepToolCalls,
    redact: shared.capture.redact,
    sourceFilters: captureSourceFilters(shared.capture.sources),
    sources: [...enabled],
    paths: {
      claude: shared.capture.sources["claude-code"].paths,
      codex: shared.capture.sources.codex.paths,
      grok: shared.capture.sources["grok-build"].paths,
      cursor: shared.capture.sources.cursor.paths,
      gemini: shared.capture.sources["gemini-cli"].paths,
      pi: shared.capture.sources.pi.paths,
      t3: shared.capture.sources["t3-code"].paths,
      zcode: shared.capture.sources.zcode.paths,
    },
  });
  const counts = new Map<string, number>();
  for (const id of enabled) counts.set(id, 0);
  for (const session of discovered.sessions) {
    counts.set(session.source, (counts.get(session.source) ?? 0) + 1);
  }
  io.log("各来源可回填的会话：");
  for (const [id, count] of counts) io.log(`- ${id}：${count}`);
  const choice = flags.backfill ?? (flags.yes ? true : undefined);
  const accepted = choice ?? (await confirm("现在标记首次回填？daemon 启动后会上传这些会话。", true, io));
  if (!accepted) {
    io.log("已跳过首次回填。");
    return;
  }
  const store = new SqliteStore(stateFile);
  try {
    store.setCursor("capture.backfill", "pending");
  } finally {
    store.close();
  }
  io.log("已标记首次回填。");
}

function describeItem(item: IntegrationPlanItem): string {
  const where = item.path ? ` ${item.path}` : "";
  const warning = item.warning ? `（${item.warning}）` : "";
  return `${item.client} ${item.kind} ${item.action}${where}${warning}`;
}

async function readShared(path: string): Promise<SharedConfig> {
  if (!existsSync(path)) return createDefaultSharedConfig();
  const text = await readFile(path, "utf8");
  return parseSharedConfig(JSON.parse(text) as unknown);
}

async function saveShared(
  dataDir: string,
  shared: SharedConfig,
  drive: DrivePort | null,
): Promise<void> {
  await writeJson(join(dataDir, "shared.json"), shared);
  if (!drive) return;
  await upsertByPath(drive, DRIVE_PATHS.sharedConfig, `${JSON.stringify(shared, null, 2)}\n`, {
    mimeType: "application/json",
  });
}

async function readProgress(path: string): Promise<SetupProgress> {
  if (!existsSync(path)) return { ...EMPTY_PROGRESS };
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SetupProgress>;
    return { ...EMPTY_PROGRESS, ...parsed, version: 1 };
  } catch {
    return { ...EMPTY_PROGRESS };
  }
}

async function saveProgress(dataDir: string, progress: SetupProgress): Promise<void> {
  await writeJson(join(dataDir, "setup.json"), progress);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function requireTty(topic: string, io: SetupIo): void {
  if (io.isTTY) return;
  throw new CliError(`当前不是交互终端，无法询问${topic}。请使用 --yes 或提供对应参数。`);
}

async function defaultAsk(question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new CliError(`当前不是交互终端，无法询问${question}。请使用 --yes 或提供对应参数。`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim();
    return answer === "" ? fallback : answer;
  } finally {
    rl.close();
  }
}

async function confirm(question: string, fallback: boolean, io: SetupIo): Promise<boolean> {
  requireTty(question, io);
  const answer = await io.ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `, "");
  if (answer === "") return fallback;
  return answer === "y" || answer === "Y" || answer === "yes" || answer === "是";
}

function isProvider(value: string): value is LlmProvider {
  return (LLM_PROVIDERS as readonly string[]).includes(value);
}

function isSource(value: string): value is SessionSource {
  return (SESSION_SOURCES as readonly string[]).includes(value);
}

function asSources(value: string): SessionSource[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((id) => {
      if (!isSource(id)) throw new CliError(`未知接入客户端：${id}`);
      return id;
    });
}
