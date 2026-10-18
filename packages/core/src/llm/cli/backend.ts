import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LlmProvider } from "@you-brain/protocol";

import { LlmRequestError } from "../errors.js";
import { LLM_PRESETS } from "../presets.js";
import type { LlmBackend, LlmCompleteRequest } from "../types.js";
import { runCliConnectionTest } from "../types.js";
import { cliDriver, looksUnauthenticated, type CliBuildContext, type CliDriver } from "./drivers.js";
import { cliFailure, DEFAULT_CLI_TIMEOUT_MS, runCliProcess, withCliSlot } from "./exec.js";
import { appendSchemaInstruction } from "./json.js";
import { isCliProvider, locateCliBinary, type CliProvider } from "./locate.js";
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
      ...(options.env ? { env: options.env } : {}),
      secrets,
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
    await Promise.all(temps.map((path) => rm(path, { force: true })));
  }
}

export async function createCliBackend(options: CreateCliBackendOptions): Promise<LlmBackend> {
  if (!isCliProvider(options.provider)) {
    throw new LlmRequestError("client", `不是本机订阅 Provider：${options.provider}`);
  }
  const provider: CliProvider = options.provider;
  const driver = cliDriver(provider);
  const bin = locateCliBinary({
    provider,
    ...(options.cliBin !== undefined ? { bin: options.cliBin } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
  });
  if (!bin) {
    throw new LlmRequestError("client", `未找到 ${driver.command} 命令行，请先安装并登录`);
  }
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
