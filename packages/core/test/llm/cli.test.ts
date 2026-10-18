import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createLlmBackend } from "../../src/llm/factory.js";
import { LlmRequestError } from "../../src/llm/errors.js";
import { isCliNoOutputTimeout } from "../../src/llm/cli/exec.js";
import { extractFirstJsonObject } from "../../src/llm/cli/json.js";
import type { CliProvider } from "../../src/llm/cli/locate.js";
import { llmCliWorkDir, physicalPath } from "../../src/llm/cli/workdir.js";

const roots: string[] = [];
const schema = {
  type: "object",
  properties: { word: { type: "string" } },
  required: ["word"],
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "you-brain-cli-"));
  roots.push(root);
  return root;
}

const FAKE_SCRIPT = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";

const mode = process.env.FAKE_MODE ?? "ok";
const driver = process.env.FAKE_DRIVER ?? "";
const log = process.env.FAKE_LOG ?? "";
const marker = process.env.FAKE_MARKER ?? "";
const schema = process.env.FAKE_SCHEMA === "1";

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : "";
}

const stdin = await readStdin();
const argv = process.argv.slice(2);
const promptFile = argValue(argv, "--prompt-file");
const prompt = promptFile ? readFileSync(promptFile, "utf8") : "";
if (log) {
  appendFileSync(
    log,
    JSON.stringify({ event: "start", argv, cwd: process.cwd(), stdin, prompt, at: Date.now() }) + "\\n",
  );
}

if (mode === "timeout" || mode === "timeout-output") {
  if (mode === "timeout-output") writeSync(2, "still working\\n");
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  if (marker) writeFileSync(marker, process.pid + "\\n" + child.pid + "\\n");
  await new Promise(() => {});
}
if (mode === "fail") {
  console.error("tool exploded");
  process.exit(2);
}
if (mode === "auth") {
  console.error("not logged in");
  process.exit(1);
}
if (mode === "auth0") {
  console.error("Failed to authenticate with authorization code: invalid_grant");
  console.log("not-json");
  process.exit(0);
}
if (mode === "probe") {
  const payload = JSON.stringify({ ok: true });
  const last = argValue(argv, "--output-last-message");
  if (driver === "codex") {
    if (last) writeFileSync(last, payload);
    console.log("codex-stdout-ignored");
  } else if (driver === "grok") {
    console.log(JSON.stringify({ structuredOutput: { ok: true }, result: "" }));
  } else if (driver === "claude") {
    console.log(JSON.stringify({ type: "result", is_error: false, structured_output: { ok: true }, result: "" }));
  } else if (driver === "gemini") {
    console.log(JSON.stringify({ session_id: "s", response: payload, stats: {} }));
  } else if (driver === "opencode") {
    console.log(JSON.stringify({ type: "text", part: { text: payload } }));
  } else {
    console.log(payload);
  }
  if (log) appendFileSync(log, JSON.stringify({ event: "end", at: Date.now() }) + "\\n");
  process.exit(0);
}
if (mode === "codex400" || mode === "codex401" || mode === "codex429" || mode === "codex500" || mode === "codexnet") {
  const last = argValue(argv, "--output-last-message");
  if (last) writeFileSync(last, "");
  if (mode === "codexnet") {
    console.log("ERROR: error sending request: connection reset");
    console.error("Warning: no last agent message; wrote empty content to " + last);
    process.exit(0);
  }
  const status = mode === "codex401" ? 401 : mode === "codex429" ? 429 : mode === "codex500" ? 500 : 400;
  const reason = mode === "codex401" ? "Unauthorized" : mode === "codex429" ? "Too Many Requests" : mode === "codex500" ? "Internal Server Error" : "Bad Request";
  const detail = mode === "codex400"
    ? "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account."
    : "temporary";
  const payload = JSON.stringify({ detail });
  console.log("stream error: unexpected status " + status + " " + reason + ": " + payload + "; retrying 1/5");
  console.log("ERROR: unexpected status " + status + " " + reason + ": " + payload);
  console.error("Warning: no last agent message; wrote empty content to " + last);
  process.exit(0);
}
if (mode === "exit0-error") {
  if (driver === "grok") {
    console.log('ERROR: unexpected status 400 Bad Request: {"detail":"nope"}');
    process.exit(0);
  }
  if (driver === "claude") {
    console.log(JSON.stringify({ type: "result", is_error: false, result: "" }));
    console.error('ERROR: unexpected status 400 Bad Request: {"detail":"nope"}');
    process.exit(0);
  }
  if (driver === "gemini") {
    console.log(JSON.stringify({ error: { message: "model rejected" } }));
    process.exit(0);
  }
  if (driver === "opencode") {
    console.log(JSON.stringify({ type: "error", error: { message: "model rejected" } }));
    process.exit(0);
  }
  if (driver === "codex") {
    const last = argValue(argv, "--output-last-message");
    if (last) writeFileSync(last, "");
    console.log('ERROR: unexpected status 400 Bad Request: {"detail":"nope"}');
    console.error("Warning: no last agent message; wrote empty content to " + last);
    process.exit(0);
  }
}
if (mode === "leak") {
  console.error(prompt || stdin || argv.join(" "));
  process.exit(2);
}
if (mode === "slow") {
  await new Promise((resolve) => setTimeout(resolve, 350));
  console.log(JSON.stringify({ result: "ok" }));
  if (log) appendFileSync(log, JSON.stringify({ event: "end", at: Date.now() }) + "\\n");
  process.exit(0);
}

const fenced = "\`\`\`json\\n{\\"word\\":\\"ok\\"}\\n\`\`\`";
const body = mode === "bad" ? "this is not json" : mode === "fenced" ? fenced : "ok";
const jsonBody = schema ? "{\\"word\\":\\"ok\\"}" : body;
const last = argValue(argv, "--output-last-message");

if (driver === "codex") {
  if (last) {
    const written = mode === "ok" && argv.includes("--output-schema") ? "{\\"word\\":\\"ok\\"}" : body;
    writeFileSync(last, written);
  }
  console.log("codex-stdout");
} else if (driver === "grok") {
  if (mode === "ok" && argv.includes("--json-schema")) {
    console.log(JSON.stringify({ structuredOutput: { word: "ok" }, result: "" }));
  } else if (mode === "fenced") {
    console.log(JSON.stringify({ result: body }));
  } else if (mode === "bad") {
    console.log(body);
  } else {
    console.log(JSON.stringify({ result: "ok" }));
  }
} else if (driver === "claude") {
  if (mode === "ok" && argv.includes("--json-schema")) {
    console.log(JSON.stringify({ type: "result", is_error: false, structured_output: { word: "ok" }, result: "" }));
  } else if (mode === "fenced") {
    console.log(JSON.stringify({ type: "result", is_error: false, result: body }));
  } else if (mode === "bad") {
    console.log(body);
  } else {
    console.log(JSON.stringify({ type: "result", is_error: false, result: "ok" }));
  }
} else if (driver === "gemini") {
  console.log(JSON.stringify({ session_id: "s", response: mode === "ok" ? jsonBody : body, stats: {} }));
} else if (driver === "opencode") {
  console.log(JSON.stringify({ type: "text", part: { text: mode === "ok" ? jsonBody : body } }));
} else {
  console.log(body);
}
if (log) appendFileSync(log, JSON.stringify({ event: "end", at: Date.now() }) + "\\n");
`;

async function installFake(root: string): Promise<string> {
  const path = join(root, "fake-cli");
  await writeFile(path, FAKE_SCRIPT, { mode: 0o755 });
  return path;
}

interface DriverCase {
  provider: CliProvider;
  driver: string;
  login: string;
  unsafe: string[];
  required: string[][];
}

const DRIVERS: DriverCase[] = [
  {
    provider: "grok-cli",
    driver: "grok",
    login: "grok login",
    unsafe: ["--yolo"],
    required: [
      ["--tools", ""],
      ["--no-subagents"],
      ["--disable-web-search"],
      ["--max-turns", "1"],
      ["--no-plan"],
      ["--prompt-file"],
    ],
  },
  {
    provider: "claude-cli",
    driver: "claude",
    login: "claude（交互里 /login）",
    unsafe: ["bypassPermissions", "--dangerously-skip-permissions"],
    required: [
      ["-p"],
      ["--tools", ""],
      ["--no-session-persistence"],
      ["--permission-mode", "dontAsk"],
      ["--permission-prompts", "none"],
      ["--strict-mcp-config"],
    ],
  },
  {
    provider: "codex-cli",
    driver: "codex",
    login: "codex login",
    unsafe: ["--full-auto", "danger-full-access", "workspace-write"],
    required: [["exec"], ["-s", "read-only"], ["--skip-git-repo-check"], ["--output-last-message"]],
  },
  {
    provider: "gemini-cli",
    driver: "gemini",
    login: "gemini（交互里完成登录）",
    unsafe: ["--yolo", "-y", "auto_edit"],
    required: [["-o", "json"], ["--approval-mode", "default"]],
  },
  {
    provider: "opencode-cli",
    driver: "opencode",
    login: "opencode auth login",
    unsafe: ["--auto"],
    required: [["run"], ["--format", "json"], ["--agent", "plan"], ["--standalone"], ["--"]],
  },
];

function hasSequence(argv: string[], sequence: string[]): boolean {
  for (let index = 0; index <= argv.length - sequence.length; index += 1) {
    if (sequence.every((part, offset) => argv[index + offset] === part)) return true;
  }
  return false;
}

async function backendFor(
  root: string,
  bin: string,
  item: DriverCase,
  extra: { mode?: string; schema?: boolean; model?: string; timeoutMs?: number; marker?: string },
) {
  const log = join(root, `${item.driver}-${extra.mode ?? "ok"}.log`);
  const env: NodeJS.ProcessEnv = {
    FAKE_MODE: extra.mode ?? "ok",
    FAKE_DRIVER: item.driver,
    FAKE_LOG: log,
    FAKE_SCHEMA: extra.schema ? "1" : "0",
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    ...(extra.marker ? { FAKE_MARKER: extra.marker } : {}),
  };
  const backend = await createLlmBackend({
    config: { provider: item.provider, model: extra.model ?? "", baseUrl: "" },
    getApiKey: () => {
      throw new Error("cli backend must not read an API key");
    },
    cliBin: bin,
    dataDir: root,
    env,
    homeDir: join(root, "home"),
    ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
  });
  return { backend, log, env };
}

function readLog(log: string): Array<{ event: string; argv: string[]; cwd: string; prompt: string; at: number }> {
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { event: string; argv: string[]; cwd: string; prompt: string; at: number });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 4_000) {
    if (existsSync(path) && statSync(path).size > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe("subscription cli backends", () => {
  test("extracts the first JSON object, including a fenced one", () => {
    expect(extractFirstJsonObject('prefix {"a":1} suffix {"b":2}')).toBe('{"a":1}');
    expect(extractFirstJsonObject('```json\n{"word":"ok"}\n```')).toBe('{"word":"ok"}');
    expect(extractFirstJsonObject('noise {"keep":"{not}"} trailing {"no":1}')).toBe('{"keep":"{not}"}');
    expect(extractFirstJsonObject("no object here")).toBeNull();
  });

  for (const item of DRIVERS) {
    test(`${item.provider} returns schema JSON and plain text`, async () => {
      const root = await tempDir();
      const bin = await installFake(root);
      const schemaRun = await backendFor(root, bin, item, { schema: true });
      const json = await schemaRun.backend.complete({
        system: "Reply with exactly one lowercase word and nothing else.",
        user: "say ok",
        jsonSchema: schema,
      });
      expect(JSON.parse(json)).toEqual({ word: "ok" });
      const events = readLog(schemaRun.log);
      const argv = events[0]?.argv ?? [];
      for (const sequence of item.required) expect(hasSequence(argv, sequence)).toBe(true);
      for (const flag of item.unsafe) expect(argv).not.toContain(flag);
      expect(argv).not.toContain("-m");
      expect(argv).not.toContain("--model");
      expect(events[0]?.cwd).toBe(physicalPath(llmCliWorkDir(root)));

      const plain = await backendFor(root, bin, item, { mode: "ok" });
      expect(
        await plain.backend.complete({
          system: "Reply with exactly one lowercase word and nothing else.",
          user: "ok",
        }),
      ).toBe("ok");
    });

    test(`${item.provider} reports non-zero exit, auth, bad JSON, and fenced JSON`, async () => {
      const root = await tempDir();
      const bin = await installFake(root);
      const failed = await backendFor(root, bin, item, { mode: "fail", schema: true });
      const failure = await failed.backend
        .complete({ system: "system", user: "user", jsonSchema: schema })
        .then(
          () => {
            throw new Error("expected failure");
          },
          (caught: unknown) => caught,
        );
      expect(failure).toBeInstanceOf(LlmRequestError);
      expect((failure as LlmRequestError).kind).toBe("server");
      expect((failure as LlmRequestError).message).toContain("退出码 2");
      expect((failure as LlmRequestError).message).toContain("tool exploded");

      const auth = await backendFor(root, bin, item, { mode: "auth" });
      const denied = await auth.backend.complete({ system: "system", user: "user" }).then(
        () => {
          throw new Error("expected auth failure");
        },
        (caught: unknown) => caught,
      );
      expect(denied).toBeInstanceOf(LlmRequestError);
      expect((denied as LlmRequestError).kind).toBe("auth");
      expect((denied as LlmRequestError).retryable).toBe(false);
      expect((denied as LlmRequestError).message).toContain(item.login);

      if (item.provider === "gemini-cli") {
        const grant = await backendFor(root, bin, item, { mode: "auth0", schema: true });
        const expired = await grant.backend
          .complete({ system: "system", user: "user", jsonSchema: schema })
          .then(
            () => {
              throw new Error("expected auth failure");
            },
            (caught: unknown) => caught,
          );
        expect(expired).toBeInstanceOf(LlmRequestError);
        expect((expired as LlmRequestError).kind).toBe("auth");
        expect((expired as LlmRequestError).retryable).toBe(false);
        expect((expired as LlmRequestError).message).not.toContain("输出无法解析");
      }

      const bad = await backendFor(root, bin, item, { mode: "bad", schema: true });
      const unparsed = await bad.backend
        .complete({ system: "system", user: "user", jsonSchema: schema })
        .then(
          () => {
            throw new Error("expected parse failure");
          },
          (caught: unknown) => caught,
        );
      expect(unparsed).toBeInstanceOf(LlmRequestError);
      expect((unparsed as LlmRequestError).message).toContain("输出无法解析");

      const fenced = await backendFor(root, bin, item, { mode: "fenced", schema: true });
      expect(JSON.parse(await fenced.backend.complete({ system: "system", user: "user", jsonSchema: schema }))).toEqual({
        word: "ok",
      });
    });

    test(`${item.provider} hides the prompt and is killed on timeout`, async () => {
      const root = await tempDir();
      const bin = await installFake(root);
      const secret = `SECRET_PROMPT_${"x".repeat(48)}`;
      const leaked = await backendFor(root, bin, item, { mode: "leak" });
      const error = await leaked.backend.complete({ system: "system prompt", user: secret }).then(
        () => {
          throw new Error("expected leak failure");
        },
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(LlmRequestError);
      expect((error as LlmRequestError).message).not.toContain(secret);
      expect((error as LlmRequestError).message).toContain("命令执行失败");

      const marker = join(root, `${item.driver}.pids`);
      const timed = await backendFor(root, bin, item, { mode: "timeout", timeoutMs: 700, marker });
      const pending = timed.backend.complete({ system: "system", user: "ok" });
      await waitForFile(marker);
      const timeout = await pending.then(
        () => {
          throw new Error("expected timeout");
        },
        (caught: unknown) => caught,
      );
      expect(timeout).toBeInstanceOf(LlmRequestError);
      expect(isCliNoOutputTimeout(timeout)).toBe(true);
      expect((timeout as LlmRequestError).kind).toBe("network");
      expect((timeout as LlmRequestError).retryable).toBe(true);
      expect((timeout as LlmRequestError).message).toContain("没有任何输出");
      expect((timeout as LlmRequestError).message).toContain("可能需要重新登录");
      expect((timeout as LlmRequestError).message).toContain(item.login);
      await new Promise((resolve) => setTimeout(resolve, 800));
      const [parent, child] = readFileSync(marker, "utf8")
        .trim()
        .split("\n")
        .map((value) => Number(value));
      expect(parent).toBeGreaterThan(0);
      expect(child).toBeGreaterThan(0);
      expect(alive(parent ?? 0)).toBe(false);
      expect(alive(child ?? 0)).toBe(false);
    }, 15_000);
  }

  test("a timeout that already printed output stays a retryable network error", async () => {
    const root = await tempDir();
    const bin = await installFake(root);
    const grok = DRIVERS.find((item) => item.provider === "grok-cli");
    if (!grok) throw new Error("missing grok driver");
    const timed = await backendFor(root, bin, grok, { mode: "timeout-output", timeoutMs: 700 });
    const timeout = await timed.backend.complete({ system: "system", user: "ok" }).then(
      () => {
        throw new Error("expected timeout");
      },
      (caught: unknown) => caught,
    );
    expect(timeout).toBeInstanceOf(LlmRequestError);
    expect(isCliNoOutputTimeout(timeout)).toBe(false);
    expect((timeout as LlmRequestError).kind).toBe("network");
    expect((timeout as LlmRequestError).retryable).toBe(true);
    expect((timeout as LlmRequestError).message).toContain("请求超时");
    expect((timeout as LlmRequestError).message).toContain("still working");
  });

  test("codex treats an empty last-message file as a failed call", async () => {
    const root = await tempDir();
    const bin = await installFake(root);
    const codex = DRIVERS.find((item) => item.provider === "codex-cli");
    if (!codex) throw new Error("missing codex driver");
    const cases = [
      {
        mode: "codex400",
        kind: "client",
        retryable: false,
        message:
          "codex 调用失败：The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.（可在模型名里指定该账号支持的模型）",
      },
      { mode: "codex401", kind: "auth", retryable: false, message: "codex 调用失败：temporary" },
      { mode: "codex429", kind: "rate_limit", retryable: true, message: "codex 调用失败：temporary" },
      { mode: "codex500", kind: "server", retryable: true, message: "codex 调用失败：temporary" },
      {
        mode: "codexnet",
        kind: "network",
        retryable: true,
        message: "codex 调用失败：error sending request: connection reset",
      },
    ] as const;
    for (const item of cases) {
      const run = await backendFor(root, bin, codex, { mode: item.mode });
      const error = await run.backend.complete({ system: "system", user: "hello" }).then(
        (text) => {
          throw new Error(`expected failure, got ${text}`);
        },
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(LlmRequestError);
      const failure = error as LlmRequestError;
      expect(failure.kind).toBe(item.kind);
      expect(failure.retryable).toBe(item.retryable);
      expect(failure.message).toBe(item.message);
      expect(failure.message).not.toContain("stream error");
    }
    const probe = await backendFor(root, bin, codex, { mode: "codex400" });
    const tested = await probe.backend.test().then(
      () => {
        throw new Error("expected test failure");
      },
      (caught: unknown) => caught,
    );
    expect(tested).toBeInstanceOf(LlmRequestError);
    expect((tested as LlmRequestError).kind).toBe("client");
    expect((tested as LlmRequestError).message).toContain("gpt-6-astra");
    expect((tested as LlmRequestError).message).toContain("可在模型名里指定该账号支持的模型");
  });

  test("connection test requires a schema object and exit 0 logs are not replies", async () => {
    const root = await tempDir();
    const bin = await installFake(root);
    for (const item of DRIVERS) {
      const probe = await backendFor(root, bin, item, { mode: "probe" });
      await probe.backend.test();
    }
    for (const item of DRIVERS) {
      const failed = await backendFor(root, bin, item, { mode: "exit0-error" });
      const error = await failed.backend
        .complete({ system: "system", user: "hello", jsonSchema: schema })
        .then(
          (text) => {
            throw new Error(`${item.provider} accepted failure output: ${text}`);
          },
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(LlmRequestError);
      const failure = error as LlmRequestError;
      expect(failure.retryable).toBe(item.provider === "codex-cli" ? false : failure.retryable);
      if (item.provider === "codex-cli" || item.provider === "grok-cli" || item.provider === "claude-cli") {
        expect(failure.kind).toBe("client");
        expect(failure.message).toContain("nope");
      } else {
        expect(failure.message).toContain("model rejected");
      }
      expect(failure.message).not.toContain('"type":"error"');
    }
  });

  test("keeps CLI calls serial, uses the dedicated cwd, and deletes prompt files", async () => {
    const root = await tempDir();
    const bin = await installFake(root);
    const first = await backendFor(root, bin, DRIVERS[0]!, { mode: "slow" });
    const second = await backendFor(root, bin, DRIVERS[1]!, { mode: "slow" });
    const log = join(root, "serial.log");
    first.env.FAKE_LOG = log;
    second.env.FAKE_LOG = log;
    const left = await createLlmBackend({
      config: { provider: "grok-cli", model: "demo-model", baseUrl: "" },
      getApiKey: () => null,
      cliBin: bin,
      dataDir: root,
      env: first.env,
      homeDir: join(root, "home"),
    });
    const right = await createLlmBackend({
      config: { provider: "claude-cli", model: "", baseUrl: "" },
      getApiKey: () => null,
      cliBin: bin,
      dataDir: root,
      env: second.env,
      homeDir: join(root, "home"),
    });
    const [grokText, claudeText] = await Promise.all([
      left.complete({ system: "system", user: "left" }),
      right.complete({ system: "system", user: "right" }),
    ]);
    expect(grokText).toBe("ok");
    expect(claudeText).toBe("ok");
    const events = readLog(log);
    expect(events.map((event) => event.event)).toEqual(["start", "end", "start", "end"]);
    expect(events[1]?.at ?? 0).toBeLessThanOrEqual(events[2]?.at ?? 0);
    expect(events.every((event) => event.event === "end" || event.cwd === physicalPath(llmCliWorkDir(root)))).toBe(
      true,
    );
    const grokArgv = events.find((event) => event.event === "start" && event.argv.includes("--prompt-file"))?.argv ?? [];
    expect(hasSequence(grokArgv, ["-m", "demo-model"])).toBe(true);
    const promptFile = grokArgv[grokArgv.indexOf("--prompt-file") + 1] ?? "";
    expect(promptFile).not.toBe("");
    expect(existsSync(promptFile)).toBe(false);
    const schemaRun = await backendFor(root, bin, DRIVERS[2]!, { schema: true });
    await schemaRun.backend.complete({ system: "system", user: "schema", jsonSchema: schema });
    const codex = readLog(schemaRun.log)[0];
    const schemaFile = codex?.argv[codex.argv.indexOf("--output-schema") + 1] ?? "";
    const lastFile = codex?.argv[codex.argv.indexOf("--output-last-message") + 1] ?? "";
    expect(schemaFile).not.toBe("");
    expect(existsSync(schemaFile)).toBe(false);
    expect(existsSync(lastFile)).toBe(false);
  }, 15_000);
});
