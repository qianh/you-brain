import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Tool ids and the names the model is shown. Either spelling removes the tool. */
export const GROK_DISALLOWED_TOOLS = [
  "run_terminal_cmd",
  "run_terminal_command",
  "write",
  "search_replace",
  "StrReplace",
  "EditNotebook",
  "Delete",
  "task",
  "spawn_subagent",
  "workflow",
  "web_search",
  "web_fetch",
  "image_gen",
  "image_edit",
  "image_to_video",
  "reference_to_video",
  "monitor",
  "scheduler_create",
  "scheduler_delete",
  "scheduler_list",
  "search_tool",
  "use_tool",
  "Agent",
].join(",");

/** Bare prefixes. Deny wins over always-approve and over the built-in `touch` allow. */
export const GROK_DENY_RULES = ["Bash", "Edit", "Write", "MCPTool", "WebFetch", "WebSearch"] as const;

const COMPAT_OFF = {
  GROK_CLAUDE_HOOKS_ENABLED: "0",
  GROK_CLAUDE_MCPS_ENABLED: "0",
  GROK_CLAUDE_SKILLS_ENABLED: "0",
  GROK_CLAUDE_AGENTS_ENABLED: "0",
  GROK_CLAUDE_RULES_ENABLED: "0",
  GROK_CURSOR_HOOKS_ENABLED: "0",
  GROK_CURSOR_MCPS_ENABLED: "0",
  GROK_CURSOR_SKILLS_ENABLED: "0",
  GROK_CURSOR_AGENTS_ENABLED: "0",
  GROK_CURSOR_RULES_ENABLED: "0",
  GROK_MEMORY: "0",
} as const;

/** Parent session and overlays that would widen this call or raise max_retries. */
export const GROK_UNSET_ENV = [
  "GROK_AGENT",
  "GROK_SESSION_ID",
  "GROK_CONFIG",
  "GROK_CONFIG_PATH",
  "GROK_SANDBOX",
] as const;

export function grokIsolationEnv(home: string): NodeJS.ProcessEnv {
  return { ...COMPAT_OFF, GROK_HOME: home };
}

function configText(): string {
  const deny = GROK_DENY_RULES.map((rule) => `"${rule}"`).join(", ");
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
 * A private grok home so the user's MCP servers, hooks, and always-approve
 * mode are not loaded. Auth is copied read-only; the source file is not written.
 */
export async function prepareGrokHome(scratch: string, userHome: string): Promise<string> {
  const home = join(scratch, "grok-home");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.toml"), configText(), "utf8");
  const source = join(userHome, ".grok", "auth.json");
  const target = join(home, "auth.json");
  try {
    await copyFile(source, target);
    await chmod(target, 0o400);
  } catch {
    // This home has no grok login. The CLI reports that on its own.
  }
  return home;
}
