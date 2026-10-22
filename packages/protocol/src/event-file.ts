import { EventSchema, parseEvent, type Event } from "./events.js";

export interface JsonlParseError {
  line: number;
  message: string;
}

export interface JsonlParseResult {
  events: Event[];
  errors: JsonlParseError[];
}

export type EventLineResult = { ok: true; event: Event } | { ok: false; error: string };

/** One physical line. A blank line is `{ ok: false, error: "empty line" }`. */
export function parseEventLine(line: string): EventLineResult {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (text.trim() === "") return { ok: false, error: "empty line" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid JSON" };
  }
  const result = EventSchema.safeParse(parsed);
  if (!result.success) return { ok: false, error: result.error.message };
  return { ok: true, event: result.data };
}

/**
 * Blank lines are skipped. A bad line is reported with a 1-based line number
 * and does not stop the rest of the file.
 */
export function parseEventsJsonl(text: string): JsonlParseResult {
  const events: Event[] = [];
  const errors: JsonlParseError[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    const parsed = parseEventLine(line);
    if (!parsed.ok) {
      errors.push({ line: index + 1, message: parsed.error });
      continue;
    }
    events.push(parsed.event);
  }
  return { events, errors };
}

/** One JSON object and a trailing newline. */
export function serializeEventLine(event: Event): string {
  return `${JSON.stringify(parseEvent(event))}\n`;
}

export function serializeEventsJsonl(events: readonly Event[]): string {
  if (events.length === 0) return "";
  return events.map((event) => serializeEventLine(event)).join("");
}
