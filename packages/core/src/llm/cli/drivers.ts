import { readFile } from "node:fs/promises";

import { LlmRequestError } from "../errors.js";
import type { CliRunResult } from "./exec.js";
import { cliFailure, redactSecrets } from "./exec.js";
import {
  cliProcessFailure,
  isCliFailureLog,
  recordErrorMessage,
} from "./failure.js";
import { extractFirstJsonObject, jsonText } from "./json.js";
import { GROK_DENY_RULES, GROK_DISALLOWED_TOOLS } from "./grok-isolation.js";
import { cliLoginCommand, type CliProvider } from "./locate.js";

export interface CliBuildContext {
  cwd: string;
  model: string;
  system: string;
  user: string;
  jsonSchema?: object;
  promptFile?: string;
  schemaFile?: string;
  lastMessageFile?: string;
  skillsDir?: string;
  secrets: readonly string[];
}

export interface CliBuilt {
  args: string[];
  stdin?: string;
}

/** 流式运行支持：参数换成流式输出格式，并从 JSONL 事件里增量提取模型文本。 */
export interface CliStreamSupport {
  args(ctx: CliBuildContext): CliBuilt;
  /** 返回一个有状态的提取器：每个 stdout chunk 进，模型文本增量出。 */
  extractor(): (chunk: string) => string;
}

export interface CliDriver {
  provider: CliProvider;
  command: string;
  nativeSchema: boolean;
  loginMessage: string;
  promptFile: boolean;
  schemaFile: boolean;
  lastMessageFile: boolean;
  skillsDir: boolean;
  build(ctx: CliBuildContext): CliBuilt;
  parse(result: CliRunResult, ctx: CliBuildContext): Promise<string>;
  stream?: CliStreamSupport;
}

/**
 * JSONL 事件流提取器：按行缓冲（一行可能拆在多个 chunk 里），完整行交给
 * pick 挑出模型文本。坏行（半行尾巴之外的垃圾）忽略。
 */
function jsonlExtractor(pick: (record: Record<string, unknown>) => string): (chunk: string) => string {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let out = "";
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === "") continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record && typeof record === "object" && !Array.isArray(record)) {
        out += pick(record as Record<string, unknown>);
      }
    }
    return out;
  };
}

const AUTH_PATTERNS = [
  /not logged in/iu,
  /login required/iu,
  /please log in/iu,
  /please login/iu,
  /authentication required/iu,
  /sign in to (?:grok|continue)/iu,
  /please set an auth method/iu,
  /failed to authenticate/iu,
  /invalid_grant/iu,
  /no model configured/iu,
  /use \/login/iu,
  /GEMINI_API_KEY/u,
  /unauthorized/iu,
  /auth login/iu,
  /codex login/iu,
  /grok login/iu,
  /claude auth login/iu,
];

export function looksUnauthenticated(result: CliRunResult): boolean {
  if (result.exitCode === 0) return AUTH_PATTERNS.some((pattern) => pattern.test(result.stderr));
  const text = `${result.stderr}\n${result.stdout}`;
  return AUTH_PATTERNS.some((pattern) => pattern.test(text));
}

function modelArgs(model: string, flag: string): string[] {
  return model.trim() === "" ? [] : [flag, model];
}

function parseRecord(text: string): Record<string, unknown> | null {
  const extracted = extractFirstJsonObject(text);
  if (!extracted) return null;
  try {
    const parsed = JSON.parse(extracted) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requireOutput(text: string, ctx: CliBuildContext, stderr: string): string {
  if (isCliFailureLog(text) || (text.trim() === "" && isCliFailureLog(stderr))) {
    throw cliProcessFailure("cli", text, stderr, ctx.secrets);
  }
  if (ctx.jsonSchema) {
    const json = jsonText(text);
    if (!json) throw cliFailure("server", "输出无法解析", stderr, ctx.secrets);
    return json;
  }
  if (text.trim() === "") throw cliFailure("server", "模型返回为空", stderr, ctx.secrets);
  return text.trim();
}

function hasStructured(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => {
    const value = record[key];
    return value !== undefined && value !== null && jsonText(value) !== null;
  });
}

function hasText(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => {
    const value = asText(record[key]);
    return value !== null && value.trim() !== "";
  });
}

function structuredOrText(
  record: Record<string, unknown> | null,
  raw: string,
  ctx: CliBuildContext,
  stderr: string,
  structuredKeys: string[],
  textKeys: string[],
): string {
  if (record?.is_error === true || record?.isError === true) {
    const detail = asText(record.result) ?? asText(record.error) ?? asText(record.message) ?? "";
    throw cliFailure("server", "命令执行失败（退出码 0）", `${detail}\n${stderr}`, ctx.secrets);
  }
  const errorText = recordErrorMessage(record);
  if (
    record &&
    errorText &&
    !hasStructured(record, structuredKeys) &&
    !hasText(record, textKeys)
  ) {
    throw cliFailure(
      "server",
      `命令执行失败（退出码 0）：${redactSecrets(errorText, ctx.secrets)}`,
      stderr,
      ctx.secrets,
    );
  }
  if (ctx.jsonSchema && record) {
    for (const key of structuredKeys) {
      if (record[key] !== undefined && record[key] !== null) {
        const json = jsonText(record[key]);
        if (json) return json;
      }
    }
  }
  if (record) {
    for (const key of textKeys) {
      const text = asText(record[key]);
      if (text !== null) return requireOutput(text, ctx, stderr);
    }
  }
  return requireOutput(raw, ctx, stderr);
}

function grokArgs(ctx: CliBuildContext, outputFormat: "json" | "streaming-json"): CliBuilt {
  return {
    args: [
      "--prompt-file",
      ctx.promptFile ?? "",
      "--system-prompt-override",
      ctx.system,
      "--output-format",
      outputFormat,
      "--permission-mode",
      "dontAsk",
      ...GROK_DENY_RULES.flatMap((rule) => ["--deny", rule]),
      "--sandbox",
      "read-only",
      "--disallowed-tools",
      GROK_DISALLOWED_TOOLS,
      "--no-subagents",
      "--disable-web-search",
      // 1 会在写出结果前用完，grok 以 "max turns reached" 退出。
      "--max-turns",
      "4",
      "--no-plan",
      "--no-memory",
      "--no-auto-update",
      "--verbatim",
      // Without this grok uses the user's global default, which can be xhigh and runs ~3x slower.
      "--effort",
      "low",
      "--cwd",
      ctx.cwd,
      ...modelArgs(ctx.model, "-m"),
      ...(ctx.jsonSchema ? ["--json-schema", JSON.stringify(ctx.jsonSchema)] : []),
    ],
  };
}

const grokDriver: CliDriver = {
  provider: "grok-cli",
  command: "grok",
  nativeSchema: true,
  loginMessage: `未登录 grok。请运行 ${cliLoginCommand("grok-cli")}`,
  promptFile: true,
  schemaFile: false,
  lastMessageFile: false,
  skillsDir: false,
  build(ctx) {
    return grokArgs(ctx, "json");
  },
  parse(result, ctx) {
    return Promise.resolve(
      structuredOrText(
        parseRecord(result.stdout),
        result.stdout,
        ctx,
        result.stderr,
        ["structuredOutput", "structured_output"],
        ["result", "response", "message", "text"],
      ),
    );
  },
  stream: {
    args(ctx) {
      return grokArgs(ctx, "streaming-json");
    },
    extractor() {
      // {"type":"text","data":"…"}：模型输出逐段进来（schema 模式下就是决策 JSON 本身）。
      return jsonlExtractor((record) =>
        record.type === "text" && typeof record.data === "string" ? record.data : "",
      );
    },
  },
};

function claudeArgs(ctx: CliBuildContext, streaming: boolean): CliBuilt {
  return {
    args: [
      "-p",
      "--output-format",
      streaming ? "stream-json" : "json",
      ...(streaming ? ["--verbose", "--include-partial-messages"] : []),
      "--tools",
      "",
      "--system-prompt",
      ctx.system,
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--strict-mcp-config",
      "--disable-slash-commands",
      ...modelArgs(ctx.model, "--model"),
      ...(ctx.jsonSchema ? ["--json-schema", JSON.stringify(ctx.jsonSchema)] : []),
    ],
    stdin: ctx.user,
  };
}

const claudeDriver: CliDriver = {
  provider: "claude-cli",
  command: "claude",
  nativeSchema: true,
  loginMessage: `未登录 claude。请运行 ${cliLoginCommand("claude-cli")}`,
  promptFile: false,
  schemaFile: false,
  lastMessageFile: false,
  skillsDir: false,
  build(ctx) {
    return claudeArgs(ctx, false);
  },
  parse(result, ctx) {
    return Promise.resolve(
      structuredOrText(
        parseRecord(result.stdout),
        result.stdout,
        ctx,
        result.stderr,
        ["structured_output", "structuredOutput"],
        ["result"],
      ),
    );
  },
  stream: {
    args(ctx) {
      return claudeArgs(ctx, true);
    },
    extractor() {
      // schema 模式下回答走 StructuredOutput 工具调用的 input_json_delta；
      // 纯文本回答走 content_block_delta 的 text_delta。一次响应只出现其一。
      return jsonlExtractor((record) => {
        if (record.type !== "stream_event") return "";
        const event = record.event;
        if (!event || typeof event !== "object" || Array.isArray(event)) return "";
        const payload = event as { type?: unknown; delta?: unknown };
        if (payload.type !== "content_block_delta") return "";
        const delta = payload.delta;
        if (!delta || typeof delta !== "object" || Array.isArray(delta)) return "";
        const piece = delta as { type?: unknown; text?: unknown; partial_json?: unknown };
        if (piece.type === "text_delta" && typeof piece.text === "string") return piece.text;
        if (piece.type === "input_json_delta" && typeof piece.partial_json === "string") {
          return piece.partial_json;
        }
        return "";
      });
    },
  },
};

const codexDriver: CliDriver = {
  provider: "codex-cli",
  command: "codex",
  nativeSchema: true,
  loginMessage: `未登录 codex。请运行 ${cliLoginCommand("codex-cli")}`,
  promptFile: false,
  schemaFile: true,
  lastMessageFile: true,
  skillsDir: false,
  build(ctx) {
    const prompt = ctx.system.trim() === "" ? ctx.user : `${ctx.system}\n\n${ctx.user}`;
    return {
      args: [
        "exec",
        "-s",
        "read-only",
        "-C",
        ctx.cwd,
        "--skip-git-repo-check",
        "--color",
        "never",
        "--output-last-message",
        ctx.lastMessageFile ?? "",
        ...modelArgs(ctx.model, "-m"),
        ...(ctx.schemaFile ? ["--output-schema", ctx.schemaFile] : []),
        "-",
      ],
      stdin: prompt,
    };
  },
  async parse(result, ctx) {
    let text = "";
    if (ctx.lastMessageFile) {
      try {
        text = await readFile(ctx.lastMessageFile, "utf8");
      } catch {
        text = "";
      }
    }
    if (text.trim() === "") {
      throw cliProcessFailure("codex", result.stdout, result.stderr, ctx.secrets);
    }
    return requireOutput(text, ctx, result.stderr);
  },
};

const geminiDriver: CliDriver = {
  provider: "gemini-cli",
  command: "gemini",
  nativeSchema: false,
  loginMessage: `未登录 gemini。请运行 ${cliLoginCommand("gemini-cli")}`,
  promptFile: false,
  schemaFile: false,
  lastMessageFile: false,
  skillsDir: false,
  build(ctx) {
    const prompt = ctx.system.trim() === "" ? ctx.user : `${ctx.system}\n\n${ctx.user}`;
    return {
      args: [
        "-o",
        "json",
        "--approval-mode",
        "default",
        ...modelArgs(ctx.model, "-m"),
      ],
      stdin: prompt,
    };
  },
  parse(result, ctx) {
    const record = parseRecord(result.stdout);
    if (record) {
      const response = asText(record.response);
      const failure = recordErrorMessage(record);
      if ((response === null || response.trim() === "") && failure) {
        throw cliFailure(
          "server",
          `命令执行失败（退出码 0）：${redactSecrets(failure, ctx.secrets)}`,
          result.stderr,
          ctx.secrets,
        );
      }
      if (response !== null) return Promise.resolve(requireOutput(response, ctx, result.stderr));
      return Promise.resolve(requireOutput("", ctx, result.stderr));
    }
    return Promise.resolve(requireOutput(result.stdout, ctx, result.stderr));
  },
};

function opencodeArgs(ctx: CliBuildContext): CliBuilt {
  const message = ctx.system.trim() === "" ? ctx.user : `${ctx.system}\n\n${ctx.user}`;
  return {
    args: [
      "run",
      "--format",
      "json",
      "--agent",
      "plan",
      "--standalone",
      ...modelArgs(ctx.model, "-m"),
      "--",
      message,
    ],
  };
}

const opencodeDriver: CliDriver = {
  provider: "opencode-cli",
  command: "opencode",
  nativeSchema: false,
  loginMessage: `未登录 opencode。请运行 ${cliLoginCommand("opencode-cli")}`,
  promptFile: false,
  schemaFile: false,
  lastMessageFile: false,
  skillsDir: false,
  build: opencodeArgs,
  parse(result, ctx) {
    const texts: string[] = [];
    let failure = "";
    let sawEvent = false;
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const record = parseRecord(trimmed);
      if (!record) continue;
      sawEvent = true;
      if (record.type === "error") {
        failure =
          failure ||
          recordErrorMessage(record) ||
          asText(record.message) ||
          "命令执行失败（退出码 0）";
        continue;
      }
      if (record.type === "text") {
        const part = record.part;
        if (typeof part === "string") texts.push(part);
        else if (typeof part === "object" && part !== null && !Array.isArray(part)) {
          const text = asText((part as Record<string, unknown>).text);
          if (text) texts.push(text);
        }
        const direct = asText(record.text);
        if (direct) texts.push(direct);
      }
    }
    if (texts.length > 0) return Promise.resolve(requireOutput(texts.join(""), ctx, result.stderr));
    if (failure) {
      throw cliFailure(
        "server",
        `命令执行失败（退出码 0）：${redactSecrets(failure, ctx.secrets)}`,
        result.stderr,
        ctx.secrets,
      );
    }
    if (sawEvent) return Promise.resolve(requireOutput("", ctx, result.stderr));
    return Promise.resolve(requireOutput(result.stdout, ctx, result.stderr));
  },
  stream: {
    args: opencodeArgs,
    extractor() {
      // 与 parse 同一事件格式：type:"text" 的 part/text 就是模型输出。
      return jsonlExtractor((record) => {
        if (record.type !== "text") return "";
        const part = record.part;
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && !Array.isArray(part)) {
          return asText((part as Record<string, unknown>).text) ?? "";
        }
        return asText(record.text) ?? "";
      });
    },
  },
};

const DRIVERS: Record<CliProvider, CliDriver> = {
  "grok-cli": grokDriver,
  "claude-cli": claudeDriver,
  "codex-cli": codexDriver,
  "gemini-cli": geminiDriver,
  "opencode-cli": opencodeDriver,
};

export function cliDriver(provider: CliProvider): CliDriver {
  const driver = DRIVERS[provider];
  if (!driver) throw new LlmRequestError("client", `未知命令行 Provider：${provider}`);
  return driver;
}
