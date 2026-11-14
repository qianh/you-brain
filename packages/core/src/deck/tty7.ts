import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { openTty7Terminal, type TerminalSize, type Tty7TerminalEvents, type TerminalConnection } from "./tty7-terminal.js";

/**
 * tty7 会话桥（ADR-0004）：指挥台列出 tty7 里的终端会话、往指定会话发指令、在某个目录新开会话并启动 AI CLI。
 * 列表和启动经 CLI；交互视图经 socket 直连原 pane 的实时终端数据。
 * 真正干活的仍是会话里的 CLI；这里不解析也不保存会话内容。
 */

/** 新建会话时可选的 AI CLI。命令是敲进会话 shell 的，所以用的是用户自己 shell 的 PATH。 */
export interface Tty7Harness {
  id: string;
  label: string;
  /** 空串 = 只开 shell，不启动任何 CLI。 */
  command: string;
}

export const TTY7_HARNESSES: Tty7Harness[] = [
  { id: "claude", label: "Claude Code", command: "claude" },
  { id: "codex", label: "Codex", command: "codex" },
  { id: "gemini", label: "Gemini CLI", command: "gemini" },
  { id: "opencode", label: "OpenCode", command: "opencode" },
  { id: "kimi", label: "Kimi Code", command: "kimi" },
  { id: "grok", label: "Grok", command: "grok" },
  { id: "shell", label: "Shell", command: "" },
];

export interface Tty7Workspace {
  id: string;
  name: string;
  /** 有 GUI 窗口正连着它。 */
  attached: boolean;
}

export interface Tty7Session {
  /** pane 编号，即 tty7 的 %N 地址。 */
  pane: number;
  workspaceId: string;
  workspaceName: string;
  tabId: string;
  /** tty7 给 tab 起的标题（通常是 agent 会话标题或目录名）。 */
  tabLabel: string | null;
  /** agent 名（Codex、Claude…）：hooks 上报了用 pane 自己的，否则退回 tty7 在 tab 上识别出的。 */
  agent: string | null;
  cwd: string;
  hibernated: boolean;
  /**
   * 会话里 agent 的状态，由 tty7 的 agent hooks 上报；没装 hooks 或会话是装之前启动的，为 null。
   * pane 级别，比 tab 上的 agent 名更准。
   */
  status: Tty7AgentStatus | null;
  /** 状态附带的一句话（例如在等什么确认）。 */
  statusMessage: string | null;
  /** agent 当前用的模型，上报了才有。 */
  model: string | null;
}

export type Tty7AgentStatus = "idle" | "working" | "waiting" | "done";
const AGENT_STATUSES: readonly string[] = ["idle", "working", "waiting", "done"];

export interface Tty7SessionsView {
  available: boolean;
  /** 不可用时的原因（没装、服务没起）。 */
  detail: string;
  workspaces: Tty7Workspace[];
  sessions: Tty7Session[];
  harnesses: Array<Pick<Tty7Harness, "id" | "label">>;
}

export interface Tty7ScreenView {
  pane: number;
  text: string;
}

export interface Tty7SendInput {
  pane: number;
  /** 要打进去的文字；多行按粘贴整块送达。 */
  text?: string | undefined;
  /** 文字之后按回车。 */
  enter?: boolean | undefined;
  /** 单独的按键（escape、C-c、up…），在文字和回车之后发。 */
  keys?: string[] | undefined;
}

export interface Tty7StartInput {
  cwd: string;
  harness: string;
  /** 放进哪个工作区；缺省用有窗口连着的那个，没有就新建。 */
  workspace?: string | undefined;
}

export interface Tty7StartResult {
  pane: number;
  workspaceId: string;
  tabId: string;
}

export interface Tty7RunOptions {
  stdin?: string;
  timeoutMs?: number;
}

/** 跑一次 tty7 命令，返回 stdout；非零退出抛错（message 用 stderr）。测试注入假的。 */
export type Tty7Runner = (args: string[], options?: Tty7RunOptions) => Promise<string>;

export interface Tty7Options {
  env?: NodeJS.ProcessEnv | undefined;
  runner?: Tty7Runner;
  /** 粘贴图片的落盘目录（缺省系统临时目录下的 you-brain-tty7）；测试注入。 */
  tmpDir?: string | undefined;
  /** 测试用：跳过目录存在性检查和等待。 */
  dirExists?: (path: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

const RUN_TIMEOUT_MS = 8_000;
/** 粘贴之后隔一下再回车：TUI（Claude Code 等）紧跟着粘贴的回车会被当成粘贴内容的一部分。 */
const ENTER_AFTER_PASTE_MS = 200;
/** 新开的 shell 要等到提示符出来再敲命令，最多等这么久。 */
const PROMPT_WAIT_MS = 6_000;
const PROMPT_POLL_MS = 250;
const SCREEN_LINES_MAX = 400;

/** `tty7 send --key` 接受的键名。 */
const KEY_PATTERN =
  /^(enter|return|escape|esc|tab|backtab|shift-tab|space|backspace|delete|up|down|left|right|home|end|pageup|pagedown|[CM]-[\x21-\x7e])$/;

/** 粘贴图片允许的类型 → 文件扩展名；CLI 里 PNG/JPEG 最稳，WebP/GIF 顺带支持。 */
const PASTE_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/** GUI 启动的 daemon 的 PATH 里通常没有 Homebrew，所以再补几个固定位置。 */
const FALLBACK_BINARIES = [
  "/opt/homebrew/bin/tty7",
  "/usr/local/bin/tty7",
  "/Applications/tty7.app/Contents/MacOS/tty7",
];

export async function locateTty7(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const fromPath = (env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "")
    .map((dir) => join(dir, "tty7"));
  for (const candidate of [...fromPath, ...FALLBACK_BINARIES]) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 换下一个位置。
    }
  }
  return null;
}

function spawnRunner(binary: string, env: NodeJS.ProcessEnv): Tty7Runner {
  return (args, options) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`tty7 ${args[0] ?? ""} 超时`));
      }, options?.timeoutMs ?? RUN_TIMEOUT_MS);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim().replace(/^tty7:\s*/, "") || `tty7 退出码 ${code}`));
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(options?.stdin ?? "");
    });
}

function parse<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

function assertPane(pane: number): string {
  if (!Number.isInteger(pane) || pane < 0) throw new Error("会话编号不正确");
  return `%${pane}`;
}

interface RawWorkspace { id: string; name: string | null; attached: string | null }
interface RawPane { pane: number; workspace: string; tab: string; cwd: string | null; live: boolean; hibernated: boolean }
interface RawAgent {
  pane_id: number;
  agent: string | null;
  state?: { status?: string; message?: string | null; readout?: { model?: string | null } | null } | null;
}
interface RawTab { id: string; name: string | null; label: string | null; agent: string | null; panes: number[] }

export class Tty7 {
  readonly #options: Tty7Options;
  #runner: Tty7Runner | null;

  constructor(options: Tty7Options = {}) {
    this.#options = options;
    this.#runner = options.runner ?? null;
  }

  openTerminal(pane: number, size: TerminalSize, events: Tty7TerminalEvents): TerminalConnection {
    return openTty7Terminal({ pane, size, events, env: this.#options.env });
  }

  async #run(args: string[], options?: Tty7RunOptions): Promise<string> {
    if (!this.#runner) {
      const env = this.#options.env ?? process.env;
      const binary = await locateTty7(env);
      if (!binary) throw new Tty7MissingError();
      this.#runner = spawnRunner(binary, env);
    }
    return this.#runner(args, options);
  }

  #sleep(ms: number): Promise<void> {
    return (this.#options.sleep ?? ((wait) => new Promise((resolve) => setTimeout(resolve, wait))))(ms);
  }

  async #workspaces(): Promise<Tty7Workspace[]> {
    const raw = parse<{ workspaces: RawWorkspace[] }>(await this.#run(["ws", "ls", "--json"]));
    return raw.workspaces.map((item) => ({ id: item.id, name: item.name ?? item.id.slice(0, 8), attached: item.attached !== null }));
  }

  /** 全部会话。tty7 没装或服务没起时 available=false，不抛错（面板要能显示原因）。 */
  async sessions(): Promise<Tty7SessionsView> {
    const harnesses = TTY7_HARNESSES.map(({ id, label }) => ({ id, label }));
    try {
      const workspaces = await this.#workspaces();
      const [panes, agentList, tabLists] = await Promise.all([
        this.#run(["pane", "ls", "--json"]).then((out) => parse<{ panes: RawPane[] }>(out).panes),
        // 状态是锦上添花：拿不到不影响列会话。
        this.#run(["agents", "--json"])
          .then((out) => parse<{ agents: RawAgent[] }>(out).agents)
          .catch(() => [] as RawAgent[]),
        Promise.all(
          workspaces.map((workspace) =>
            this.#run(["tab", "ls", workspace.id, "--json"])
              .then((out) => parse<{ tabs: RawTab[] }>(out).tabs)
              .catch(() => [] as RawTab[]),
          ),
        ),
      ]);
      const tabs = new Map<string, RawTab>();
      for (const tab of tabLists.flat()) tabs.set(tab.id, tab);
      const agents = new Map(agentList.map((agent) => [agent.pane_id, agent]));
      const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
      const sessions = panes
        .filter((pane) => pane.live)
        .map((pane): Tty7Session => {
          const tab = tabs.get(pane.tab);
          const agent = agents.get(pane.pane);
          const status = agent?.state?.status;
          return {
            pane: pane.pane,
            workspaceId: pane.workspace,
            workspaceName: names.get(pane.workspace) ?? "",
            tabId: pane.tab,
            tabLabel: tab?.name ?? tab?.label ?? null,
            agent: agent?.agent ?? tab?.agent ?? null,
            cwd: pane.cwd ?? "",
            hibernated: pane.hibernated,
            status: status !== undefined && AGENT_STATUSES.includes(status) ? (status as Tty7AgentStatus) : null,
            statusMessage: agent?.state?.message ?? null,
            model: agent?.state?.readout?.model ?? null,
          };
        });
      return { available: true, detail: "", workspaces, sessions, harnesses };
    } catch (error) {
      const detail =
        error instanceof Tty7MissingError ? "没有找到 tty7 命令" : error instanceof Error ? error.message : String(error);
      return { available: false, detail, workspaces: [], sessions: [], harnesses };
    }
  }

  /** 会话当前屏幕的纯文本（最后 lines 行）。capture 是 tty7 里最贵的命令（~300ms），只跑一次。 */
  async screen(pane: number, lines = 120): Promise<Tty7ScreenView> {
    const tail = Math.max(1, Math.min(SCREEN_LINES_MAX, Math.floor(lines)));
    const out = await this.#run(["capture", assertPane(pane), "--plain", "--tail", String(tail), "--json"]);
    return { pane, text: parse<{ text: string }>(out).text };
  }

  /** 只关闭指定 pane，挂断其中的 shell；同一 tab 的其他 pane 保留。 */
  async delete(pane: number): Promise<void> {
    await this.#run(["pane", "close", assertPane(pane), "--json"]);
  }

  async send(input: Tty7SendInput): Promise<void> {
    const target = assertPane(input.pane);
    const keys = input.keys ?? [];
    for (const key of keys) {
      if (!KEY_PATTERN.test(key)) throw new Error(`不支持的按键：${key}`);
    }
    const text = input.text ?? "";
    if (text === "" && input.enter !== true && keys.length === 0) throw new Error("没有要发送的内容");
    if (text !== "") {
      // 文字走 stdin：不出现在 ps 里，也不用考虑 shell 转义；--paste 让多行整块到达而不是逐行执行。
      await this.#run(["send", target, "--paste", "--stdin", "--json"], { stdin: text });
    }
    if (input.enter === true) {
      if (text !== "") await this.#sleep(ENTER_AFTER_PASTE_MS);
      await this.#run(["send", target, "--enter", "--json"]);
    }
    if (keys.length > 0) {
      await this.#run(["send", target, ...keys.flatMap((key) => ["--key", key]), "--json"]);
    }
  }

  /** 在 cwd 新开一个 tab，等 shell 提示符出来后敲入所选 CLI 的启动命令。 */
  async start(input: Tty7StartInput): Promise<Tty7StartResult> {
    const harness = TTY7_HARNESSES.find((item) => item.id === input.harness);
    if (!harness) throw new Error(`未知的 AI CLI：${input.harness}`);
    const cwd = input.cwd.trim();
    if (!isAbsolute(cwd)) throw new Error("路径要写绝对路径");
    const exists = this.#options.dirExists ?? defaultDirExists;
    if (!(await exists(cwd))) throw new Error(`目录不存在：${cwd}`);

    const workspaceId = input.workspace ?? (await this.#defaultWorkspace());
    const created = parse<{ tab: string; pane: number }>(
      await this.#run(["tab", "new", workspaceId, "--cwd", cwd, "--json"]),
    );
    if (harness.command !== "") {
      await this.#waitForPrompt(created.pane);
      await this.#run(["send", assertPane(created.pane), "--stdin", "--json"], { stdin: harness.command });
      await this.#run(["send", assertPane(created.pane), "--enter", "--json"]);
    }
    return { pane: created.pane, workspaceId, tabId: created.tab };
  }

  async #defaultWorkspace(): Promise<string> {
    const workspaces = await this.#workspaces();
    const picked = workspaces.find((workspace) => workspace.attached) ?? workspaces[0];
    if (picked) return picked.id;
    return parse<{ id: string }>(await this.#run(["ws", "new", "--json"])).id;
  }

  /**
   * 把粘贴的图片写成本机文件，返回绝对路径：tty7 只能发文本，
   * 图片以路径的形式进指令，会话里的 CLI（Claude Code、Codex 等）自己按路径读图。
   */
  async saveImagePaste(data: Uint8Array, contentType: string): Promise<string> {
    const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    const ext = PASTE_IMAGE_EXTENSIONS[type];
    if (ext === undefined) throw new Error(`不支持的图片类型：${contentType}`);
    const dir = this.#options.tmpDir ?? join(tmpdir(), "you-brain-tty7");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`);
    await writeFile(file, data);
    return file;
  }

  /** 等不到也照发：输入会留在 pty 缓冲里，shell 起来后照样执行。 */
  async #waitForPrompt(pane: number): Promise<void> {
    const deadline = Date.now() + PROMPT_WAIT_MS;
    while (Date.now() < deadline) {
      try {
        const procs = parse<{ context?: { at_prompt?: boolean } }>(await this.#run(["procs", assertPane(pane), "--json"]));
        if (procs.context?.at_prompt === true) return;
      } catch {
        // pane 刚建好时探测可能失败，继续等。
      }
      await this.#sleep(PROMPT_POLL_MS);
    }
  }
}

class Tty7MissingError extends Error {
  constructor() {
    super("没有找到 tty7 命令");
  }
}

async function defaultDirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
