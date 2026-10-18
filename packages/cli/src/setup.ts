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
  type LocalConfig,
  type SessionSource,
} from "@you-brain/core";
import {
  createOAuthClientSecretStore,
  setLlmApiKey,
} from "@you-brain/core/auth";
import { captureSourceFilters, discoverSessions, getAdapter } from "@you-brain/core/adapters";
import {
  applyClientIntegrations,
  planClientIntegrations,
  type IntegrationPlanItem,
} from "@you-brain/core/clients";
import { openGoogleDrive } from "@you-brain/core/daemon";
import type { DrivePort } from "@you-brain/core/drive";
import { createLlmBackend } from "@you-brain/core/llm";
import {
  applyBrainHubDefaults,
  applyBrainHubMigration,
  planBrainHubMigration,
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
  /** Undefined asks, unless --yes which backfills. */
  backfill?: boolean;
  displayName?: string;
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

export async function runSetup(flags: SetupFlags): Promise<void> {
  const platform = supportedPlatform();
  const paths = runtimePaths();
  const homeDir = homedir();
  await mkdir(paths.dataDir, { recursive: true });
  const progress = await readProgress(join(paths.dataDir, "setup.json"));
  const migration = await planBrainHubMigration({
    homeDir,
    platform,
    env: process.env,
  });
  let config: LocalConfig;
  let drive: DrivePort | null = null;

  if (!existsSync(paths.configFile)) {
    const inherit = await decideInherit(flags, migration.detected, progress.brainhub);
    const defaults = inherit ? migration.defaults : {};
    config = applyBrainHubDefaults(
      createDefaultLocalConfig({
        hostname: flags.displayName ?? hostname(),
        dataDir: paths.dataDir,
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
    if (inherit && migration.items.length > 0) {
      const backupDir = join(paths.dataDir, "migrate", String(Date.now()));
      const applied = await applyBrainHubMigration({
        context: { homeDir, platform, env: process.env },
        plan: migration,
        selectedIds: migration.items.map((item) => item.id),
        backupDir,
      });
      console.log(`已接管 BrainHub，备份在 ${applied.backupDir}`);
    }
    progress.brainhub = true;
  } else {
    config = (
      await loadLocalConfig({
        homeDir,
        platform,
        env: process.env,
      })
    ).config;
    if (!progress.brainhub || flags.inheritBrainhub || flags.skipBrainhub) {
      const inherit = await decideInherit(flags, migration.detected, false);
      if (inherit && migration.items.length > 0) {
        const backupDir = join(paths.dataDir, "migrate", String(Date.now()));
        await applyBrainHubMigration({
          context: { homeDir, platform, env: process.env },
          plan: migration,
          selectedIds: migration.items.map((item) => item.id),
          backupDir,
        });
        console.log(`已移除 BrainHub 定时任务与 MCP 条目，备份在 ${backupDir}`);
      }
      progress.brainhub = true;
    }
  }
  await saveProgress(paths.dataDir, progress);

  if (!progress.google || flags.oauth || flags.clientId || flags.clientSecret) {
    config = await configureGoogle(flags, config, paths.configFile, platform);
    const opened = await openGoogleDrive({
      local: config,
      configFile: paths.configFile,
      platform,
      interactive: !flags.yes,
      ...(flags.clientSecret ? { clientSecret: flags.clientSecret } : {}),
    });
    if (opened) {
      config = opened.config;
      drive = opened.drive;
      console.log(`已登录 Google Drive${config.account.email ? `（${config.account.email}）` : ""}`);
    } else if (flags.yes) {
      console.log("尚未登录 Google Drive。daemon 仍可启动，登录后会继续同步。");
    } else {
      throw new CliError("Google 登录未完成");
    }
    progress.google = true;
    await saveProgress(paths.dataDir, progress);
  }

  if (!progress.drive || flags.driveRoot) {
    if (flags.driveRoot) {
      config = { ...config, driveRoot: flags.driveRoot };
      await writeLocalConfig(paths.configFile, config);
    } else if (!flags.yes && process.stdin.isTTY) {
      const answer = await ask(`Drive 根目录名称 [${config.driveRoot}]：`, config.driveRoot);
      if (answer && answer !== config.driveRoot) {
        config = { ...config, driveRoot: answer };
        await writeLocalConfig(paths.configFile, config);
      }
    }
    console.log(`Drive 根目录：${config.driveRoot}`);
    progress.drive = true;
    await saveProgress(paths.dataDir, progress);
  }

  let shared = await readShared(join(paths.dataDir, "shared.json"));
  if (flags.driveRoot) {
    shared = parseSharedConfig({ ...shared, drive: { root: flags.driveRoot } });
  }

  if (!progress.model || flags.provider || flags.model || flags.apiKey || flags.baseUrl) {
    shared = await configureModel(flags, shared, platform);
    await saveShared(paths.dataDir, shared, drive);
    progress.model = true;
    await saveProgress(paths.dataDir, progress);
  }

  if (!progress.sources || flags.sources.length > 0) {
    shared = await configureSources(flags, shared, homeDir);
    await saveShared(paths.dataDir, shared, drive);
    progress.sources = true;
    await saveProgress(paths.dataDir, progress);
  }

  if (!progress.integrations || flags.integrations !== undefined) {
    await configureIntegrations(
      flags,
      homeDir,
      join(paths.dataDir, "managed-blocks.json"),
      shared,
      paths.dataDir,
    );
    progress.integrations = true;
    await saveProgress(paths.dataDir, progress);
  }

  if (!progress.backfill || flags.backfill !== undefined) {
    await configureBackfill(flags, shared, config.displayName, paths.stateFile);
    progress.backfill = true;
    await saveProgress(paths.dataDir, progress);
  }

  console.log("设置完成。下一步：you-brain daemon");
}

async function decideInherit(
  flags: SetupFlags,
  detected: boolean,
  alreadyDone: boolean,
): Promise<boolean> {
  if (flags.skipBrainhub) return false;
  if (flags.inheritBrainhub) return true;
  if (alreadyDone || !detected) return false;
  if (flags.yes) {
    console.log("检测到 BrainHub。未接管。需要接管时加上 --inherit-brainhub。");
    return false;
  }
  requireTty("是否接管 BrainHub");
  return confirm("检测到 BrainHub。接管配置、定时任务和 MCP 条目？", false);
}

async function configureGoogle(
  flags: SetupFlags,
  config: LocalConfig,
  configFile: string,
  platform: "darwin" | "linux",
): Promise<LocalConfig> {
  let mode = flags.oauth ?? config.oauth.mode;
  if (!flags.oauth && !flags.yes) {
    requireTty("Google 登录方式");
    const answer = await ask("Google 登录方式：1 官方  2 自带凭据 [1]：", "1");
    mode = answer === "2" ? "custom" : "official";
  }
  if (mode !== "official" && mode !== "custom") {
    throw new CliError("oauth 只能是 official 或 custom");
  }
  let clientId = flags.clientId ?? config.oauth.clientId;
  if (mode === "custom" && !clientId) {
    if (flags.yes) throw new CliError("自带凭据需要 --client-id 和 --client-secret");
    requireTty("OAuth client id");
    clientId = await ask("OAuth client id：", "");
  }
  if (mode === "custom" && flags.clientSecret) {
    await createOAuthClientSecretStore({ platform, configFile }).set(flags.clientSecret);
  } else if (mode === "custom" && !flags.yes) {
    requireTty("OAuth client secret");
    const secret = await ask("OAuth client secret：", "");
    if (secret) {
      await createOAuthClientSecretStore({ platform, configFile }).set(secret);
    }
  }
  const next: LocalConfig = {
    ...config,
    oauth: { mode, clientId: mode === "official" ? "" : clientId },
  };
  await writeLocalConfig(configFile, next);
  return next;
}

async function configureModel(
  flags: SetupFlags,
  shared: SharedConfig,
  platform: "darwin" | "linux",
): Promise<SharedConfig> {
  let provider = flags.provider ?? (flags.yes ? shared.llm.provider : "");
  if (!provider) {
    requireTty("模型 Provider");
    provider = await ask(`模型 Provider（${LLM_PROVIDERS.join(" / ")}）[${shared.llm.provider}]：`, shared.llm.provider);
  }
  if (!isProvider(provider)) {
    throw new CliError(`未知 Provider：${provider}`);
  }
  let model = flags.model ?? (flags.yes ? shared.llm.model : "");
  if (!flags.model && !flags.yes) {
    requireTty("模型名");
    model = await ask(`模型名 [${shared.llm.model || "默认"}]：`, shared.llm.model);
  }
  const baseUrl = flags.baseUrl ?? (flags.yes ? shared.llm.baseUrl : shared.llm.baseUrl);
  let apiKey = flags.apiKey ?? "";
  if (!flags.apiKey && !flags.yes && provider !== "ollama") {
    requireTty("API Key");
    apiKey = await ask("API Key（存入钥匙串）：", "");
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
  if (apiKey) await setLlmApiKey(provider, apiKey, { platform });
  if (apiKey || provider === "ollama") {
    const backend = await createLlmBackend({
      config: next.llm,
      getApiKey: async () => (apiKey === "" ? null : apiKey),
    });
    await backend.test();
    console.log("模型连接成功");
  } else {
    console.log("未配置模型 API Key。会话仍会上传，提炼会跳过。");
  }
  return next;
}

async function configureSources(
  flags: SetupFlags,
  shared: SharedConfig,
  homeDir: string,
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
    requireTty("采集来源");
    for (const id of SESSION_SOURCES) {
      const enabled = await confirm(`采集 ${id}？`, true);
      if (!enabled) {
        sources[id] = { ...sources[id], enabled: false };
        continue;
      }
      const defaults = (getAdapter(id)?.defaultRoots(homeDir) ?? []).join(",");
      const answer = await ask(`  路径（逗号分隔，空则 ${defaults || "默认"}）：`, "");
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
): Promise<void> {
  const clients = flags.integrations === undefined ? undefined : asSources(flags.integrations);
  const plan = await planClientIntegrations({
    homeDir,
    managedStatePath,
    ...(clients ? { clients } : {}),
  });
  if (plan.items.length === 0) {
    console.log("没有检测到可接入的 AI 工具。");
    return;
  }
  const selected: string[] = [];
  for (const item of plan.items) {
    console.log(describeItem(item));
    if (item.action === "unchanged" || item.action === "skipped") continue;
    const accept = flags.yes
      ? true
      : await confirm(`接入 ${item.id}？`, true);
    if (accept) selected.push(item.id);
  }
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
  console.log(`已接入 ${result.applied.length} 项，跳过 ${result.skipped.length} 项`);
}

async function configureBackfill(
  flags: SetupFlags,
  shared: SharedConfig,
  device: string,
  stateFile: string,
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
    },
  });
  const counts = new Map<string, number>();
  for (const id of enabled) counts.set(id, 0);
  for (const session of discovered.sessions) {
    counts.set(session.source, (counts.get(session.source) ?? 0) + 1);
  }
  console.log("各来源可回填的会话：");
  for (const [id, count] of counts) console.log(`- ${id}：${count}`);
  const choice = flags.backfill ?? (flags.yes ? true : undefined);
  const accepted = choice ?? (await confirm("现在标记首次回填？daemon 启动后会上传这些会话。", true));
  if (!accepted) {
    console.log("已跳过首次回填。");
    return;
  }
  const store = new SqliteStore(stateFile);
  try {
    store.setCursor("capture.backfill", "pending");
  } finally {
    store.close();
  }
  console.log("已标记首次回填。");
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

function requireTty(topic: string): void {
  if (process.stdin.isTTY) return;
  throw new CliError(`当前不是交互终端，无法询问${topic}。请使用 --yes 或提供对应参数。`);
}

async function ask(question: string, fallback: string): Promise<string> {
  requireTty(question);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim();
    return answer === "" ? fallback : answer;
  } finally {
    rl.close();
  }
}

async function confirm(question: string, fallback: boolean): Promise<boolean> {
  requireTty(question);
  const answer = await ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `, "");
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
