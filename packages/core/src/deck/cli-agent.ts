import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { GROK_UNSET_ENV, grokIsolationEnv } from "../llm/cli/grok-isolation.js";
import { extractFirstJsonObject } from "../llm/cli/json.js";
import { cliFailure, runCliProcess, withCliSlot } from "../llm/cli/exec.js";
import { LlmRequestError } from "../llm/errors.js";
import {
  cliLoginCommand,
  cliNoResponseMessage,
  formatUnusableCli,
  isCliProvider,
  locateRunnableCli,
  type CliProvider,
} from "../llm/cli/locate.js";

export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60_000;

/**
 * 本机 CLI 的 agent 模式：与 llm/cli 的补全驱动不同——放开工具与写权限，
 * 让它在一个专属 workdir 里多步自主干活。只用于派活执行，不用于主控决策。
 */

export interface RunCliAgentOptions {
  provider: CliProvider;
  workdir: string;
  prompt: string;
  system?: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/** agent 模式仍然禁止的能力：不能私设调度，不能自我繁殖子代理。 */
const AGENT_GROK_DISALLOWED = [
  "spawn_subagent",
  "workflow",
  "task",
  "scheduler_create",
  "scheduler_delete",
  "scheduler_list",
].join(",");

function grokAgentConfigText(): string {
  // 不能复用补全模式的隔离 config：它 deny 了 Bash/Edit/Write，派活就没法干活。
  const deny = AGENT_GROK_DISALLOWED
    .split(",")
    .map((rule) => `"${rule}"`)
    .join(", ");
  return `[cli]
auto_update = false

[ui]
permission_mode = "dontAsk"
yolo = false
remember_tool_approvals = false

[permission]
deny = [${deny}]

[models]
max_retries = 1

[memory]
enabled = false

[memory_v2]
enabled = false

[features]
campaigns = false
`;
}

/**
 * agent 模式的私有 grok home：与补全隔离同一思路（不加载用户的 MCP/hooks/
 * always-approve），但权限只禁调度与子代理，写文件和终端是放开的。
 */
async function prepareGrokAgentHome(scratch: string, userHome: string): Promise<string> {
  const home = join(scratch, "grok-home");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.toml"), grokAgentConfigText(), "utf8");
  try {
    const target = join(home, "auth.json");
    await copyFile(join(userHome, ".grok", "auth.json"), target);
    await chmod(target, 0o400);
  } catch {
    // 没有 grok 登录时由 CLI 自己报错。
  }
  return home;
}

interface AgentRunPlan {
  args: string[];
  stdin?: string;
  /** args 里 "--prompt-file" 后面的空占位由调用者填。 */
  promptFile: boolean;
  /** args 里 "--output-last-message" 后面的空占位由调用者填。 */
  lastMessageFile: boolean;
}

function buildAgentPlan(options: RunCliAgentOptions): AgentRunPlan {
  const model = options.model?.trim() ?? "";
  const modelArgs = model === "" ? [] : [model];
  const system = options.system?.trim() ?? "";
  const prompt = system === "" ? options.prompt : `${system}\n\n${options.prompt}`;
  switch (options.provider) {
    case "grok-cli":
      // grok 的 agent 模式必须走 --prompt-file（位置参数/stdin 会报
      // "Device not configured"），且不能传 --sandbox：本机版本没有内置的
      // workspace-write profile，声明它反而拒绝启动。放开沙箱的前提是
      // 专属 workdir + dontAsk + 禁私设调度。
      return {
        promptFile: true,
        lastMessageFile: false,
        args: [
          "--prompt-file", "",
          "--output-format", "json",
          "--permission-mode", "dontAsk",
          "--disallowed-tools", AGENT_GROK_DISALLOWED,
          "--no-subagents",
          // 派活可能要读资料再动手，60 轮比补全的 4 轮宽得多。
          "--max-turns", "60",
          "--no-plan",
          "--no-memory",
          "--no-auto-update",
          "--verbatim",
          "--cwd", options.workdir,
          ...(modelArgs.length > 0 ? ["-m", model] : []),
        ],
      };
    case "claude-cli":
      return {
        promptFile: false,
        lastMessageFile: false,
        args: [
          "-p",
          "--output-format", "json",
          "--permission-mode", "bypassPermissions",
          "--setting-sources", "",
          "--no-session-persistence",
          ...(system !== "" ? ["--append-system-prompt", system] : []),
          ...(modelArgs.length > 0 ? ["--model", model] : []),
        ],
        stdin: options.prompt,
      };
    case "codex-cli":
      return {
        promptFile: false,
        lastMessageFile: true,
        args: [
          "exec",
          "-s", "workspace-write",
          "-c", "sandbox_workspace_write.network_access=true",
          "-C", options.workdir,
          "--skip-git-repo-check",
          "--color", "never",
          "--output-last-message", "",
          ...(modelArgs.length > 0 ? ["-m", model] : []),
          "-",
        ],
        stdin: prompt,
      };
    case "gemini-cli":
      return {
        promptFile: false,
        lastMessageFile: false,
        args: [
          "-o", "json",
          "--approval-mode", "yolo",
          ...(modelArgs.length > 0 ? ["-m", model] : []),
        ],
        stdin: prompt,
      };
    case "opencode-cli":
      return {
        promptFile: false,
        lastMessageFile: false,
        args: [
          "run",
          "--format", "json",
          "--standalone",
          ...(modelArgs.length > 0 ? ["-m", model] : []),
          "--",
          prompt,
        ],
      };
  }
}

function parseRecord(text: string): Record<string, unknown> | null {
  const json = extractFirstJsonObject(text);
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseAgentText(provider: CliProvider, stdout: string, lastMessage: string): string {
  switch (provider) {
    case "codex-cli":
      return lastMessage.trim();
    case "grok-cli":
    case "claude-cli": {
      const record = parseRecord(stdout);
      if (record) {
        for (const key of ["result", "response", "message", "text"]) {
          const value = record[key];
          if (typeof value === "string" && value.trim() !== "") return value;
        }
      }
      return stdout.trim();
    }
    case "gemini-cli": {
      const record = parseRecord(stdout);
      if (record && typeof record.response === "string") return record.response;
      return stdout.trim();
    }
    case "opencode-cli": {
      const texts: string[] = [];
      for (const line of stdout.split("\n")) {
        const record = parseRecord(line.trim());
        if (!record || record.type !== "text") continue;
        const part = record.part;
        if (typeof part === "string") texts.push(part);
        else if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
          texts.push((part as Record<string, unknown>).text as string);
        }
        if (typeof record.text === "string") texts.push(record.text);
      }
      return texts.length > 0 ? texts.join("") : stdout.trim();
    }
  }
}

function looksUnauthenticated(stderr: string): boolean {
  return /not logged in|login required|please log ?in|unauthorized|invalid_grant|codex login|grok login|claude auth login|auth login/iu.test(
    stderr,
  );
}

function noOutputError(command: string, timeoutMs: number, provider: CliProvider): LlmRequestError {
  const error = cliFailure(
    "network",
    cliNoResponseMessage(command, timeoutMs, cliLoginCommand(provider)),
    "",
    [],
  );
  error.name = "CliNoOutputTimeout";
  return error;
}

export async function runCliAgent(options: RunCliAgentOptions): Promise<string> {
  if (!isCliProvider(options.provider)) {
    throw new LlmRequestError("client", `不是本机订阅 Provider：${options.provider}`);
  }
  const provider = options.provider;
  const command = cliLoginCommand(provider).split(" ")[0]!;
  const located = await locateRunnableCli({
    provider,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
  });
  if (!located.bin) {
    throw new LlmRequestError(
      "client",
      located.unusable.length > 0
        ? formatUnusableCli(located.unusable)
        : `未找到 ${command} 命令行，请先安装并登录`,
    );
  }
  const bin = located.bin;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  await mkdir(options.workdir, { recursive: true });
  const scratch = join(options.workdir, ".yb-agent");
  await mkdir(scratch, { recursive: true });
  const temps: string[] = [];
  const childEnv: NodeJS.ProcessEnv = { ...options.env };
  const unset: string[] = [];
  let grokHome = "";
  if (provider === "grok-cli") {
    grokHome = await prepareGrokAgentHome(scratch, options.homeDir ?? "");
    Object.assign(childEnv, grokIsolationEnv(grokHome));
    unset.push(...GROK_UNSET_ENV);
  }
  const plan = buildAgentPlan(options);
  if (plan.promptFile) {
    const promptFile = join(scratch, `agent-prompt-${randomUUID()}.txt`);
    await writeFile(promptFile, options.prompt, "utf8");
    temps.push(promptFile);
    plan.args[plan.args.indexOf("--prompt-file") + 1] = promptFile;
  }
  const lastMessageFile = plan.lastMessageFile
    ? join(scratch, `agent-last-${randomUUID()}.txt`)
    : "";
  if (lastMessageFile !== "") {
    temps.push(lastMessageFile);
    plan.args[plan.args.indexOf("--output-last-message") + 1] = lastMessageFile;
  }
  const secrets = [options.prompt, options.system ?? ""].filter((value) => value.length >= 16);
  try {
    const result = await withCliSlot(() =>
      runCliProcess({
        bin,
        args: plan.args,
        cwd: options.workdir,
        ...(plan.stdin !== undefined ? { stdin: plan.stdin } : {}),
        timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
        env: childEnv,
        ...(unset.length > 0 ? { unset } : {}),
        secrets,
        noOutputTimeoutMessage: cliNoResponseMessage(command, timeoutMs, cliLoginCommand(provider)),
      }),
    );
    if (looksUnauthenticated(result.stderr)) {
      throw cliFailure(
        "auth",
        `未登录 ${command}。请运行 ${cliLoginCommand(provider)}`,
        result.stderr,
        secrets,
      );
    }
    const lastMessage =
      lastMessageFile === "" ? "" : await readFile(lastMessageFile, "utf8").catch(() => "");
    const text = parseAgentText(provider, result.stdout, lastMessage);
    if (text.trim() === "") {
      if (result.stdout.trim() === "" && result.stderr.trim() === "") {
        throw noOutputError(command, timeoutMs, provider);
      }
      throw cliFailure(
        "server",
        `${command} agent 没有返回内容（退出码 ${result.exitCode}）`,
        result.stderr,
        secrets,
      );
    }
    return text;
  } finally {
    const cleanup = temps.map((path) => rm(path, { force: true }));
    if (grokHome !== "") cleanup.push(rm(grokHome, { recursive: true, force: true }));
    await Promise.all(cleanup);
  }
}
