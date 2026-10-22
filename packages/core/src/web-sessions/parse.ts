import { sessionFrontmatterFields } from "@you-brain/protocol";

export interface WebSessionTurn {
  role: "user" | "assistant";
  text: string;
}

export interface WebSessionDocument {
  source: string;
  conversationId: string;
  device: string;
  startedAt: string;
  updatedAt: string;
  /** Parsed turns. Frontmatter `turn_count` is not used here. */
  turnCount: number;
  turns: WebSessionTurn[];
}

const HEADING = /^## (User|Assistant)[ \t]*$/u;

function normalizeNewlines(markdown: string): string {
  return markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/** YAML-ish frontmatter used by uploaded session markdown. Missing block yields an empty map. */
export function frontmatter(markdown: string): Map<string, string> {
  return sessionFrontmatterFields(markdown);
}

function bodyAfterFrontmatter(markdown: string): string {
  const normalized = normalizeNewlines(markdown);
  const match = /^---\n[\s\S]*?\n---\n/u.exec(normalized);
  return match ? normalized.slice(match[0].length) : normalized;
}

function splitTurns(body: string): WebSessionTurn[] {
  const turns: WebSessionTurn[] = [];
  let role: WebSessionTurn["role"] | null = null;
  let lines: string[] = [];
  const flush = (): void => {
    if (!role) {
      lines = [];
      return;
    }
    const text = lines.join("\n").trim();
    if (text !== "") turns.push({ role, text });
    lines = [];
  };
  for (const line of body.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      role = heading[1] === "User" ? "user" : "assistant";
      continue;
    }
    if (role) lines.push(line);
  }
  flush();
  return turns;
}

/**
 * Browser-plugin session markdown. Returns null when source, conversation_id,
 * started_at, or updated_at is missing. `source` is not checked against the CLI enum.
 */
export function parseWebSession(markdown: string): WebSessionDocument | null {
  const fields = frontmatter(markdown);
  const source = fields.get("source") ?? "";
  const conversationId = fields.get("conversation_id") ?? "";
  const startedAt = fields.get("started_at") ?? "";
  const updatedAt = fields.get("updated_at") ?? "";
  if (source === "" || conversationId === "" || startedAt === "" || updatedAt === "") return null;
  const turns = splitTurns(bodyAfterFrontmatter(markdown));
  return {
    source,
    conversationId,
    device: fields.get("device") ?? "",
    startedAt,
    updatedAt,
    turnCount: turns.length,
    turns,
  };
}
