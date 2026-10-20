import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LlmProvider } from "@you-brain/protocol";

import { LlmRequestError } from "../errors.js";
import { LLM_PRESETS } from "../presets.js";
import type { LlmBackend, LlmCompleteRequest } from "../types.js";
import { runCliConnectionTest } from "../types.js";
import { cliDriver, looksUnauthenticated, type CliBuildContext, type CliDriver } from "./drivers.js";
import { cliFailure, DEFAULT_CLI_TIMEOUT_MS, runCliProcess, withCliSlot } from "./exec.js";
import { GROK_UNSET_ENV, grokIsolationEnv, prepareGrokHome } from "./grok-isolation.js";
import { appendSchemaInstruction } from "./json.js";
import {
  cliLoginCommand,
  cliNoResponseMessage,
  formatUnusableCli,
  isCliProvider,
  locateRunnableCli,
  type CliProvider,
} from "./locate.js";
import { ensureCliWorkDir } from "./workdir.js";

export interface CreateCliBackendOptions {
  provider: LlmProvider;
  model: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cliBin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function execute(
  driver: CliDriver,
  bin: string,
  options: CreateCliBackendOptions,
  request: LlmCompleteRequest,
): Promise<string> {
  const cwd = await ensureCliWorkDir(options.dataDir);
  const user =
    request.jsonSchema && !driver.nativeSchema
      ? appendSchemaInstruction(request.user, request.jsonSchema)
      : request.user;
  const secrets = [request.system, request.user, user].filter((value) => value.length >= 16);
  const scratch = join(cwd, ".yb-cli");
  await mkdir(scratch, { recursive: true });
  const temps: string[] = [];
  let grokHome = "";
  const childEnv: NodeJS.ProcessEnv = { ...options.env };
  const unset: string[] = [];
  if (driver.provider === "grok-cli") {
    grokHome = await prepareGrokHome(scratch, options.homeDir ?? homedir());
    Object.assign(childEnv, grokIsolationEnv(grokHome));
    unset.push(...GROK_UNSET_ENV);
  }
  const ctx: CliBuildContext = {
    cwd,
    model: options.model,
    system: request.system,
    user,
    secrets,
    ...(request.jsonSchema ? { jsonSchema: request.jsonSchema } : {}),
  };
  try {
    if (driver.promptFile) {
      const promptFile = join(scratch, `prompt-${randomUUID()}.txt`);
      await writeFile(promptFile, user, "utf8");
      temps.push(promptFile);
      ctx.promptFile = promptFile;
    }
    if (driver.schemaFile && request.jsonSchema) {
      const schemaFile = join(scratch, `schema-${randomUUID()}.json`);
      await writeFile(schemaFile, JSON.stringify(request.jsonSchema), "utf8");
      temps.push(schemaFile);
      ctx.schemaFile = schemaFile;
    }
    if (driver.lastMessageFile) {
      const lastMessageFile = join(scratch, `last-${randomUUID()}.txt`);
      temps.push(lastMessageFile);
      ctx.lastMessageFile = lastMessageFile;
    }
    if (driver.skillsDir) {
      const skillsDir = join(scratch, "skills");
      await mkdir(skillsDir, { recursive: true });
      ctx.skillsDir = skillsDir;
    }
    const built = driver.build(ctx);
    const result = await runCliProcess({
      bin,
      args: built.args,
      cwd,
      ...(built.stdin !== undefined ? { stdin: built.stdin } : {}),
      timeoutMs: options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      env: childEnv,
      ...(unset.length > 0 ? { unset } : {}),
      secrets,
      noOutputTimeoutMessage: cliNoResponseMessage(
        driver.command,
        options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
        cliLoginCommand(driver.provider),
      ),
    });
    if (looksUnauthenticated(result)) {
      throw cliFailure("auth", driver.loginMessage, result.stderr, secrets);
    }
    if (result.exitCode !== 0) {
      throw cliFailure(
        "server",
        `命令执行失败（退出码 ${result.exitCode}）`,
        result.stderr,
        secrets,
      );
    }
    return await driver.parse(result, ctx);
  } finally {
    const cleanup = temps.map((path) => rm(path, { force: true }));
    if (grokHome !== "") cleanup.push(rm(grokHome, { recursive: true, force: true }));
    await Promise.all(cleanup);
  }
}

export async function createCliBackend(options: CreateCliBackendOptions): Promise<LlmBackend> {
  if (!isCliProvider(options.provider)) {
    throw new LlmRequestError("client", `不是本机订阅 Provider：${options.provider}`);
  }
  const provider: CliProvider = options.provider;
  const driver = cliDriver(provider);
  const located = await locateRunnableCli({
    provider,
    ...(options.cliBin !== undefined ? { bin: options.cliBin } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
  });
  if (!located.bin) {
    throw new LlmRequestError(
      "client",
      located.unusable.length > 0
        ? formatUnusableCli(located.unusable)
        : `未找到 ${driver.command} 命令行，请先安装并登录`,
    );
  }
  const bin = located.bin;
  const preset = LLM_PRESETS[provider];
  const backend: LlmBackend = {
    id: provider,
    descriptor: {
      provider,
      kind: "cli",
      model: options.model,
      baseUrl: "",
      jsonMode: preset.jsonMode,
      requiresApiKey: false,
    },
    complete(request) {
      return withCliSlot(() => execute(driver, bin, options, request));
    },
    test() {
      return runCliConnectionTest((request) => backend.complete(request));
    },
  };
  return backend;
}
