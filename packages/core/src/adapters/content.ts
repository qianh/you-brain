import type { ImageRef, Turn } from "../domain/session.js";
import { asRecord, asString } from "./jsonl.js";

const visibleTextTypes = new Set(["text", "input_text", "output_text"]);

function parseImage(part: Record<string, unknown>): ImageRef | null {
  const source = asRecord(part.source);
  if (source?.type === "base64") {
    const data = asString(source.data);
    const mediaType = asString(source.media_type) ?? asString(source.mediaType);
    return data && mediaType ? { kind: "embedded", mediaType, data } : null;
  }

  const url =
    asString(part.image_url) ??
    asString(part.url) ??
    (asRecord(part.image_url) ? asString(asRecord(part.image_url)?.url) : null);
  if (!url) return null;
  if (url.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,(.+)$/u.exec(url);
    return match?.[1] && match[2]
      ? { kind: "embedded", mediaType: match[1], data: match[2] }
      : null;
  }
  try {
    new URL(url);
    return { kind: "remote", url };
  } catch {
    return null;
  }
}

export function visibleTurnContent(
  role: "user" | "assistant",
  content: unknown,
): Turn | null {
  if (typeof content === "string") {
    return content.length > 0 ? { role, text: content, images: [] } : null;
  }
  if (!Array.isArray(content)) return null;

  const texts: string[] = [];
  const images: ImageRef[] = [];
  for (const value of content) {
    const part = asRecord(value);
    if (!part) continue;
    const type = asString(part.type);
    if (type && visibleTextTypes.has(type)) {
      const text = asString(part.text);
      if (text) texts.push(text);
      continue;
    }
    if (type === "image" || type === "input_image" || part.image_url) {
      const image = parseImage(part);
      if (image) images.push(image);
    }
  }

  const text = texts.join("\n");
  return text || images.length > 0 ? { role, text, images } : null;
}

export function timestampBounds(
  values: Array<string | null>,
  fallback: string,
): { startedAt: string; updatedAt: string } {
  const valid = values
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.valueOf()))
    .sort((left, right) => left.valueOf() - right.valueOf());
  return {
    startedAt: (valid.at(0) ?? new Date(fallback)).toISOString(),
    updatedAt: (valid.at(-1) ?? new Date(fallback)).toISOString(),
  };
}

export function truncateText(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars === 1) return "…";
  return `${value.slice(0, maxChars - 1)}…`;
}

function argumentText(args: unknown): string {
  if (typeof args === "string") return args;
  if (args === undefined) return "";
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return "";
  }
}

export function formatToolCall(
  name: string,
  args: unknown,
  maxChars: number,
): string {
  const body = argumentText(args);
  const rendered = body.length > 0 ? `[tool] ${name} ${body}` : `[tool] ${name}`;
  return truncateText(rendered, maxChars);
}

export function toolTextFromCalls(value: unknown, maxChars: number): string {
  if (!Array.isArray(value)) return "";
  const lines: string[] = [];
  for (const entry of value) {
    const call = asRecord(entry);
    if (!call) continue;
    const name = asString(call.name) ?? "tool";
    const line = formatToolCall(
      name,
      call.input ?? call.arguments ?? call.args,
      maxChars,
    );
    if (line.length > 0) lines.push(line);
  }
  return lines.join("\n");
}

export function toolTextFromContent(content: unknown, maxChars: number): string {
  if (!Array.isArray(content)) return "";
  const lines: string[] = [];
  for (const value of content) {
    const part = asRecord(value);
    if (!part) continue;
    const type = asString(part.type);
    if (type !== "tool_use" && type !== "function_call" && type !== "toolCall") continue;
    const line = formatToolCall(
      asString(part.name) ?? "tool",
      part.input ?? part.arguments ?? part.args,
      maxChars,
    );
    if (line.length > 0) lines.push(line);
  }
  return lines.join("\n");
}

export function mergeToolText(
  turn: Turn | null,
  role: "user" | "assistant",
  toolText: string,
): Turn | null {
  if (toolText.length === 0) return turn;
  if (!turn) return { role, text: toolText, images: [] };
  if (turn.text.length === 0) return { ...turn, text: toolText };
  return { ...turn, text: `${turn.text}\n\n${toolText}` };
}
