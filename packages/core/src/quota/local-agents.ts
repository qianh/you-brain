import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Common AI agents the usage display lets the user tick, and the directory each leaves in
 * the home folder once it has been installed or run. The ids match magpie's agent ids so
 * an agent magpie has numbers for and one only found on disk share one checkbox.
 */
export const LOCAL_AGENT_DIRS: ReadonlyArray<{ agent: string; directory: string }> = [
  { agent: "claude", directory: ".claude" },
  { agent: "codex", directory: ".codex" },
  { agent: "cursor", directory: ".cursor" },
  { agent: "grok", directory: ".grok" },
  { agent: "zcode", directory: ".zcode" },
  { agent: "gemini", directory: ".gemini" },
  { agent: "antigravity", directory: ".antigravity" },
  { agent: "kimi", directory: ".kimi" },
  { agent: "opencode", directory: ".opencode" },
  { agent: "qwen", directory: ".qwen" },
  { agent: "windsurf", directory: ".windsurf" },
  { agent: "trae", directory: ".trae" },
  { agent: "pi", directory: ".pi" },
];

/** Agent ids whose home directory exists on this machine, in the list's own order. */
export function detectLocalAgents(homeDir: string, exists: (path: string) => boolean = existsSync): string[] {
  return LOCAL_AGENT_DIRS.filter(({ directory }) => exists(join(homeDir, directory))).map(({ agent }) => agent);
}
