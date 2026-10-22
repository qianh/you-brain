const REQUIRED_FIELDS = ["source", "conversation_id", "started_at", "updated_at"] as const;

export interface SessionFrontmatterError {
  path: string;
  line?: number;
  message: string;
}

export interface SessionFrontmatter {
  source: string;
  conversation_id: string;
  started_at: string;
  updated_at: string;
  device: string;
  fields: Record<string, string>;
}

export type SessionFrontmatterResult =
  | { ok: true; frontmatter: SessionFrontmatter }
  | { ok: false; errors: SessionFrontmatterError[] };

function normalizeNewlines(markdown: string): string {
  return markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/**
 * Inbox session frontmatter. A missing block yields an empty map.
 * Lines without a colon, or with the colon first, are skipped. Later duplicates win.
 */
export function sessionFrontmatterFields(markdown: string): Map<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(normalizeNewlines(markdown));
  const fields = new Map<string, string>();
  for (const line of match?.[1]?.split("\n") ?? []) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    fields.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return fields;
}

function fieldLines(body: string): Map<string, number> {
  const lines = new Map<string, number>();
  body.split("\n").forEach((line, index) => {
    const colon = line.indexOf(":");
    if (colon <= 0) return;
    lines.set(line.slice(0, colon).trim(), index + 2);
  });
  return lines;
}

/** Requires source, conversation_id, started_at, and updated_at. `device` defaults to "". */
export function parseSessionFrontmatter(markdown: string): SessionFrontmatterResult {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(normalizeNewlines(markdown));
  if (!match) {
    return { ok: false, errors: [{ path: "frontmatter", message: "缺少 frontmatter" }] };
  }
  const fields = sessionFrontmatterFields(markdown);
  const lines = fieldLines(match[1] ?? "");
  const errors: SessionFrontmatterError[] = [];
  for (const key of REQUIRED_FIELDS) {
    if ((fields.get(key) ?? "") === "") {
      const line = lines.get(key);
      errors.push({
        path: key,
        ...(line === undefined ? {} : { line }),
        message: `缺少 ${key}`,
      });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const record: Record<string, string> = {};
  for (const [key, value] of fields) record[key] = value;
  return {
    ok: true,
    frontmatter: {
      source: fields.get("source") ?? "",
      conversation_id: fields.get("conversation_id") ?? "",
      started_at: fields.get("started_at") ?? "",
      updated_at: fields.get("updated_at") ?? "",
      device: fields.get("device") ?? "",
      fields: record,
    },
  };
}
