export const M0_PROMPT = "Reply with the single word pong.";

export type CliId = "claude-code" | "codex" | "grok-build" | "gemini-cli" | "cursor";

export const CLI_IDS: readonly CliId[] = ["claude-code", "codex", "grok-build", "gemini-cli", "cursor"];

export function isCliId(value: string): value is CliId {
  return (CLI_IDS as readonly string[]).includes(value);
}

export interface CliCommand {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface CliPlan {
  id: CliId;
  installed: boolean;
  binary: string | null;
  /** Why the adapter treats two transcripts as one conversation. */
  assumption: string;
  create: CliCommand | null;
  /** `{{SESSION_ID}}` is filled after the create step. Gemini uses `latest`. */
  resume: CliCommand | null;
}

export interface CliBins {
  claude?: string;
  codex?: string;
  grok?: string;
  gemini?: string;
  cursorAgent?: string;
}

function command(argv: string[], env: Record<string, string>, cwd: string): CliCommand {
  return { argv, env, cwd };
}

export function planCliResume(input: {
  bins: CliBins;
  workDir: string;
  isolateDir: string;
}): CliPlan[] {
  const claudeHome = `${input.isolateDir}/claude`;
  const codexHome = `${input.isolateDir}/codex`;
  const grokHome = `${input.isolateDir}/grok-home`;
  const geminiHome = `${input.isolateDir}/gemini-home`;
  const claude = input.bins.claude;
  const codex = input.bins.codex;
  const grok = input.bins.grok;
  const gemini = input.bins.gemini;
  const cursor = input.bins.cursorAgent;
  return [
    {
      id: "claude-code",
      installed: Boolean(claude),
      binary: claude ?? null,
      assumption:
        "适配器 conversationId 取 jsonl 里第一条的 sessionId（~/.claude/projects/**/*.jsonl）。没有原生 parent id，continuationOf 只做内容前缀。--resume 默认复用原 session id；--fork-session 才会新 id。脚本调用 PATH 上的 claude 二进制，不经过会改写 ~/.claude.json 的 claude-buddy-guard。",
      create: claude
        ? command(
            [claude, "-p", M0_PROMPT, "--output-format", "json", "--tools", "", "--max-turns", "1", "--dangerously-skip-permissions"],
            { CLAUDE_CONFIG_DIR: claudeHome },
            input.workDir,
          )
        : null,
      resume: claude
        ? command(
            [claude, "-p", M0_PROMPT, "--resume", "{{SESSION_ID}}", "--output-format", "json", "--tools", "", "--max-turns", "1", "--dangerously-skip-permissions"],
            { CLAUDE_CONFIG_DIR: claudeHome },
            input.workDir,
          )
        : null,
    },
    {
      id: "codex",
      installed: Boolean(codex),
      binary: codex ?? null,
      assumption:
        "适配器 conversationId 取 session_meta.payload.id，否则取 rollout-*.jsonl 文件名。原生延续是 payload.forked_from_id。非交互续聊是 `codex exec resume <SESSION_ID>`，交互式 `codex resume` 会打开选择器，脚本不用它。",
      create: codex
        ? command(
            [codex, "exec", "--skip-git-repo-check", "--sandbox", "read-only", "-C", input.workDir, "--json", M0_PROMPT],
            { CODEX_HOME: codexHome },
            input.workDir,
          )
        : null,
      resume: codex
        ? command(
            [codex, "exec", "--skip-git-repo-check", "--sandbox", "read-only", "-C", input.workDir, "--json", "resume", "{{SESSION_ID}}", M0_PROMPT],
            { CODEX_HOME: codexHome },
            input.workDir,
          )
        : null,
    },
    {
      id: "grok-build",
      installed: Boolean(grok),
      binary: grok ?? null,
      assumption:
        "适配器 conversationId 是 ~/.grok/sessions/<id> 的目录名，原生延续是 summary.json 的 parent_session_id。本机 --help：-r/--resume 按 id 或标题续聊；--fork-session 才新建 session id。脚本不传 --fork-session。隔离靠子进程 HOME，使 ~/.grok 落在临时目录。帮助里没有单独的 GROK_HOME。",
      create: grok
        ? command(
            [grok, "-p", M0_PROMPT, "--output-format", "json", "--cwd", input.workDir, "--max-turns", "1", "--no-plan", "--disable-web-search", "--permission-mode", "dontAsk"],
            { HOME: grokHome },
            input.workDir,
          )
        : null,
      resume: grok
        ? command(
            [grok, "-p", M0_PROMPT, "-r", "{{SESSION_ID}}", "--output-format", "json", "--cwd", input.workDir, "--max-turns", "1", "--no-plan", "--disable-web-search", "--permission-mode", "dontAsk"],
            { HOME: grokHome },
            input.workDir,
          )
        : null,
    },
    {
      id: "gemini-cli",
      installed: Boolean(gemini),
      binary: gemini ?? null,
      assumption:
        "适配器 conversationId 取 session JSON 的 sessionId，否则取 session-*.json 文件名（~/.gemini/tmp/**/chats/）。没有原生 parent id，只有内容前缀。本机 --help 的 --resume 接受 latest 或序号，不接受 sessionId。脚本续聊用 --resume latest，再比较文件里的 sessionId 是否变化。",
      create: gemini
        ? command(
            [gemini, M0_PROMPT, "--output-format", "json", "--approval-mode", "yolo"],
            { HOME: geminiHome },
            input.workDir,
          )
        : null,
      resume: gemini
        ? command(
            [gemini, M0_PROMPT, "--resume", "latest", "--output-format", "json", "--approval-mode", "yolo"],
            { HOME: geminiHome },
            input.workDir,
          )
        : null,
    },
    {
      id: "cursor",
      installed: Boolean(cursor),
      binary: cursor ?? null,
      assumption:
        "适配器 conversationId 是 ~/.cursor/projects/**/agent-transcripts/<id>/<id>.jsonl 的文件名。没有原生 parent id，只有内容前缀。本机 PATH 没有 cursor 或 cursor-agent。名为 agent 的二进制 --help 与 grok 相同，是 Grok Build，不能当成 Cursor。没有从本机帮助确认 resume 参数，因此不编造可执行命令。",
      create: null,
      resume: null,
    },
  ];
}

export function formatCommand(command: CliCommand): string {
  const env = Object.entries(command.env)
    .map(([key, value]) => `${key}=${quote(value)}`)
    .join(" ");
  const argv = command.argv.map(quote).join(" ");
  return `cd ${quote(command.cwd)} && ${env} ${argv}`;
}

function quote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function withSessionId(command: CliCommand, sessionId: string): CliCommand {
  return {
    ...command,
    argv: command.argv.map((arg) => (arg === "{{SESSION_ID}}" ? sessionId : arg)),
  };
}
