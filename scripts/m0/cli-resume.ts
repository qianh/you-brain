/**
 * M0 第 4 项：各 CLI 恢复会话时的 id 行为。
 *
 * 默认只打印将执行的命令（dry-run），不调用 CLI，不消耗额度。
 * 加 --run <cli> 才真的执行一个 CLI。可选值：
 *   claude-code | codex | grok-build | gemini-cli | cursor
 *
 * 用法：
 *   bun scripts/m0/cli-resume.ts
 *   bun scripts/m0/cli-resume.ts --run claude-code
 *
 * 适配器对续聊的假设（来自 packages/core/src/adapters，不是运行证据）：
 * - claude-code：conversationId 是 jsonl 第一条的 sessionId（~/.claude/projects）。
 *   没有原生 parent，continuationOf 只做内容前缀。--resume 默认复用原 session id，
 *   --fork-session 才新开 id。脚本调用 PATH 上的 claude 可执行文件，不经过会改
 *   ~/.claude.json 的 zsh 函数 claude-buddy-guard。隔离变量是 CLAUDE_CONFIG_DIR。
 * - codex：conversationId 是 session_meta.payload.id，否则是 rollout-*.jsonl 文件名。
 *   原生延续是 forked_from_id。续聊用 `codex exec ... resume <id>`，不用交互式
 *   `codex resume`。隔离变量是 CODEX_HOME。
 * - grok-build：conversationId 是 ~/.grok/sessions/<id> 的目录名，原生延续是
 *   summary.json 的 parent_session_id。-r/--resume 按 id 续聊；--fork-session 才
 *   新建 id。脚本不传 --fork-session。帮助里没有 GROK_HOME，隔离靠子进程 HOME。
 *   PATH 上的 agent 与 grok 相同，不是 Cursor。
 * - gemini-cli：conversationId 是 session JSON 的 sessionId，否则是 session-*.json
 *   文件名。没有原生 parent。--resume 接受 latest 或序号，不接受 sessionId。
 *   脚本续聊用 --resume latest。隔离靠子进程 HOME。
 * - cursor：conversationId 是 agent-transcripts/<id>/<id>.jsonl 的文件名。没有原生
 *   parent。本机没有 cursor / cursor-agent，不编造 resume 参数，--run cursor 直接跳过。
 *
 * --run 成功只表示两次调用都结束，并且比较了隔离目录里的文件和 id。它不断言 id 不变。
 * 隔离目录里没有文件时退出码 1，不续聊，也不扫描 ~/.claude、~/.codex、~/.grok、~/.gemini、~/.cursor。
 * 临时目录在 os.tmpdir()，结束删除。
 */
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasFlag, option } from "./args.ts";
import { compareSessionObservations, observeSession, resumeSessionId, type TextFile } from "./cli-observe.ts";
import { formatCommand, isCliId, planCliResume, withSessionId, type CliBins, type CliCommand, type CliId } from "./cli-plan.ts";
import { clip, emit, redactSecrets, type M0Result } from "./result.ts";

const item = "cli-resume";
const timeoutMs = 120_000;
const maxFileBytes = 1_000_000;

function usage(): string {
  return "bun scripts/m0/cli-resume.ts [--run claude-code|codex|grok-build|gemini-cli|cursor]";
}

function presentBins(): CliBins {
  const found: CliBins = {};
  const claude = Bun.which("claude");
  const codex = Bun.which("codex");
  const grok = Bun.which("grok");
  const gemini = Bun.which("gemini");
  const cursor = Bun.which("cursor-agent") ?? Bun.which("cursor");
  if (claude && !claude.endsWith("claude-buddy-guard")) found.claude = claude;
  if (codex) found.codex = codex;
  if (grok) found.grok = grok;
  if (gemini) found.gemini = gemini;
  if (cursor) found.cursorAgent = cursor;
  return found;
}

async function readTree(root: string): Promise<TextFile[]> {
  const found: TextFile[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(abs);
        if (info.size > maxFileBytes) {
          found.push({ path: rel, text: "" });
          continue;
        }
        found.push({ path: rel, text: await readFile(abs, "utf8") });
      } catch {
        found.push({ path: rel, text: "" });
      }
    }
  }
  await walk(root, "");
  found.sort((left, right) => left.path.localeCompare(right.path));
  return found;
}

async function runCommand(command: CliCommand): Promise<{
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, command.env);
  const child = Bun.spawn(command.argv, { cwd: command.cwd, env, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return {
    exitCode,
    timedOut,
    stdout: redactSecrets(clip(stdout)),
    stderr: redactSecrets(clip(stderr)),
  };
}

function dryRun(): never {
  const plans = planCliResume({
    bins: presentBins(),
    workDir: "<tmpdir>/you-brain-m0-cli/work",
    isolateDir: "<tmpdir>/you-brain-m0-cli/isolate",
  });
  emit(
    {
      item,
      ok: false,
      evidence: {
        mode: "dry-run",
        plans: plans.map((plan) => ({
          id: plan.id,
          installed: plan.installed,
          binary: plan.binary,
          assumption: plan.assumption,
          create: plan.create ? formatCommand(plan.create) : null,
          resume: plan.resume ? formatCommand(plan.resume) : null,
        })),
      },
      notes: [
        "默认不执行。加 --run <cli> 才会创建并续聊一次，消耗该 CLI 的额度。一次只跑一个。",
        "--run 成功只表示流程跑完并比较了 id，不断言 id 不变。",
        "PATH 上名为 agent 的二进制是 Grok Build，不是 Cursor。",
        "claude 用 Bun.which 找到的可执行文件。文件名若是 claude-buddy-guard，视为不可用，避免改写 ~/.claude.json。",
        "dry-run 里的 <tmpdir> 会在 --run 时换成 os.tmpdir() 下的新目录。",
      ],
    },
    2,
  );
}

async function runOne(id: CliId): Promise<void> {
  const root = join(tmpdir(), `you-brain-m0-cli-${Date.now()}`);
  const workDir = join(root, "work");
  const isolateDir = join(root, "isolate");
  let pending: { result: M0Result; code: 0 | 1 | 2 } | null = null;
  try {
    await mkdir(workDir, { recursive: true });
    const plans = planCliResume({ bins: presentBins(), workDir, isolateDir });
    const plan = plans.find((candidate) => candidate.id === id);
    if (!plan || !plan.installed || !plan.create || !plan.resume) {
      pending = {
        code: 2,
        result: {
          item,
          ok: false,
          evidence: {
            mode: "run",
            cli: id,
            installed: plan?.installed ?? false,
            binary: plan?.binary ?? null,
            assumption: plan?.assumption ?? null,
          },
          notes: [
            id === "cursor"
              ? "没有从本机帮助确认 Cursor 的 resume 参数，不编造命令，未执行。"
              : `${id} 未安装，或没有可执行的创建命令，未执行。`,
          ],
        },
      };
      return;
    }
    const created = await runCommand(plan.create);
    if (created.timedOut) {
      pending = {
        code: 1,
        result: {
          item,
          ok: false,
          evidence: { mode: "run", cli: id, create: { ...created, command: formatCommand(plan.create) } },
          notes: ["创建会话超时，未续聊。"],
        },
      };
      return;
    }
    const beforeFiles = await readTree(root);
    if (beforeFiles.length === 0) {
      pending = {
        code: 1,
        result: {
          item,
          ok: false,
          evidence: {
            mode: "run",
            cli: id,
            create: {
              exitCode: created.exitCode,
              timedOut: created.timedOut,
              stdout: created.stdout,
              stderr: created.stderr,
              command: formatCommand(plan.create),
            },
            files: [],
          },
          notes: ["隔离目录没有会话文件，未续聊，也没有扫描 ~/.claude、~/.codex、~/.grok、~/.gemini、~/.cursor。"],
        },
      };
      return;
    }
    const before = observeSession(id, created.stdout, beforeFiles);
    const sessionId = resumeSessionId(before);
    if (id !== "gemini-cli" && !sessionId) {
      pending = {
        code: 1,
        result: {
          item,
          ok: false,
          evidence: { mode: "run", cli: id, before, createExitCode: created.exitCode },
          notes: ["隔离目录有文件，但解析不出会话 id，未续聊。"],
        },
      };
      return;
    }
    const resume = id === "gemini-cli" || !sessionId ? plan.resume : withSessionId(plan.resume, sessionId);
    const continued = await runCommand(resume);
    const afterFiles = await readTree(root);
    const after = observeSession(id, continued.stdout, afterFiles);
    const comparison = compareSessionObservations(before, after);
    const ok = created.exitCode === 0 && continued.exitCode === 0 && !continued.timedOut;
    pending = {
      code: ok ? 0 : 1,
      result: {
        item,
        ok,
        evidence: {
          mode: "run",
          cli: id,
          sessionId: sessionId ?? null,
          create: { exitCode: created.exitCode, timedOut: created.timedOut, command: formatCommand(plan.create) },
          resume: { exitCode: continued.exitCode, timedOut: continued.timedOut, command: formatCommand(resume) },
          before: { adapterIds: before.adapterIds, stdoutIds: before.stdoutIds, parentIds: before.parentIds, files: before.files },
          after: { adapterIds: after.adapterIds, stdoutIds: after.stdoutIds, parentIds: after.parentIds, files: after.files },
          comparison,
        },
        notes: [
          "ok 只表示两次调用的退出码都是 0，并且已经比较了 id。adapterIdChanged 才是 id 有没有变。",
          plan.assumption,
        ],
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
    if (pending) emit(pending.result, pending.code);
  }
}

const selected = option("--run");
if (hasFlag("--run") && !selected) {
  emit({ item, ok: false, evidence: { usage: usage() }, notes: ["--run 需要一个 CLI 名称"] }, 2);
}
if (!selected) {
  dryRun();
}
if (!isCliId(selected)) {
  emit({ item, ok: false, evidence: { usage: usage(), run: selected }, notes: ["不认识的 CLI"] }, 2);
}
try {
  await runOne(selected);
} catch (error) {
  emit(
    { item, ok: false, evidence: { error: redactSecrets(error instanceof Error ? error.message : String(error)) }, notes: [] },
    1,
  );
}
