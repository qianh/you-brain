import type { CaptureSourceId } from "@you-brain/protocol";

export const MCP_SERVER_NAME = "you-brain";
export const GROK_INSTRUCTION_LIMIT = 10_000;

export const CODING_PORTRAIT_INSTRUCTION =
  "开始任何编码任务前，必须先读取 `~/.you-brain/portrait/coding.md`，其中是用户的编码偏好与规范。";

export const CLAUDE_CODING_PORTRAIT_LINE = "@~/.you-brain/portrait/coding.md";

export interface CommandSpec {
  command: string;
  args: string[];
}

export const DEFAULT_MCP_LAUNCH: CommandSpec = {
  command: "you-brain",
  args: ["mcp"],
};

export interface ClientCatalogEntry {
  id: CaptureSourceId;
  bin: string;
  directory: string;
  mcp: { format: "json"; path: string } | { format: "toml"; path: string };
  portrait:
    | { kind: "file"; path: string; body: "claude" | "instruction"; maxChars?: number }
    | { kind: "copy" };
  skillsDir: string;
  installScope: boolean;
}

export const CLIENT_CATALOG: readonly ClientCatalogEntry[] = [
  {
    id: "claude-code",
    bin: "claude",
    directory: ".claude",
    mcp: { format: "json", path: ".claude.json" },
    portrait: { kind: "file", path: ".claude/CLAUDE.md", body: "claude" },
    skillsDir: ".claude/skills",
    installScope: true,
  },
  {
    id: "codex",
    bin: "codex",
    directory: ".codex",
    mcp: { format: "toml", path: ".codex/config.toml" },
    portrait: { kind: "file", path: ".codex/AGENTS.md", body: "instruction" },
    skillsDir: ".codex/skills",
    installScope: false,
  },
  {
    id: "grok-build",
    bin: "grok",
    directory: ".grok",
    mcp: { format: "toml", path: ".grok/config.toml" },
    portrait: {
      kind: "file",
      path: ".grok/AGENTS.md",
      body: "instruction",
      maxChars: GROK_INSTRUCTION_LIMIT,
    },
    skillsDir: ".grok/skills",
    installScope: true,
  },
  {
    id: "cursor",
    bin: "cursor",
    directory: ".cursor",
    mcp: { format: "json", path: ".cursor/mcp.json" },
    portrait: { kind: "copy" },
    skillsDir: ".cursor/skills",
    installScope: false,
  },
  {
    id: "gemini-cli",
    bin: "gemini",
    directory: ".gemini",
    mcp: { format: "json", path: ".gemini/settings.json" },
    portrait: { kind: "file", path: ".gemini/GEMINI.md", body: "instruction" },
    skillsDir: ".gemini/skills",
    installScope: false,
  },
];

export function clientById(id: CaptureSourceId): ClientCatalogEntry {
  const found = CLIENT_CATALOG.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown client ${id}`);
  return found;
}

export function portraitBody(entry: ClientCatalogEntry): string {
  if (entry.portrait.kind === "copy" || entry.portrait.body === "instruction") {
    return CODING_PORTRAIT_INSTRUCTION;
  }
  return CLAUDE_CODING_PORTRAIT_LINE;
}
