export const SEARCH_SOURCES = ["claude-code", "codex", "grok-build", "cursor", "gemini-cli"] as const;

export type SearchSource = (typeof SEARCH_SOURCES)[number];

export type SearchRange = "all" | "today" | "7d" | "30d";

const DAY = 86_400_000;

export function isSearchRange(value: string): value is SearchRange {
  return value === "all" || value === "today" || value === "7d" || value === "30d";
}

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return "UTC";
  }
}

function zoneOffset(timeZone: string, instant: Date): number {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const bag: Record<string, string> = {};
  for (const part of formatted) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  let year = Number(bag.year);
  let month = Number(bag.month);
  let day = Number(bag.day);
  if (hour === 24) {
    hour = 0;
    const rolled = new Date(Date.UTC(year, month - 1, day + 1));
    year = rolled.getUTCFullYear();
    month = rolled.getUTCMonth() + 1;
    day = rolled.getUTCDate();
  }
  const asUtc = Date.UTC(year, month - 1, day, hour, Number(bag.minute), Number(bag.second));
  return asUtc - instant.getTime();
}

/** Local midnight for `now` in `timeZone`, as an absolute instant. */
export function startOfZonedDay(now: Date, timeZone: string): Date {
  const zone = safeZone(timeZone);
  const offset = zoneOffset(zone, now);
  const start = new Date(Math.floor((now.getTime() + offset) / DAY) * DAY - offset);
  const atMidnight = zoneOffset(zone, start);
  if (atMidnight === offset) return start;
  return new Date(Math.floor((now.getTime() + atMidnight) / DAY) * DAY - atMidnight);
}

export interface RangeBounds {
  from?: string;
  to?: string;
}

/**
 * Map the time chip to inclusive `from` / `to` instants.
 * "今天" is the local calendar day. "近 7 天" / "近 30 天" include today and the previous 6 / 29 local days.
 * Instants are UTC ISO strings. The search API compares them as timestamps.
 */
export function rangeBounds(range: SearchRange, now: Date, timeZone: string): RangeBounds {
  if (range === "all") return {};
  const start = startOfZonedDay(now, timeZone);
  const daysBack = range === "today" ? 0 : range === "7d" ? 6 : 29;
  const from = new Date(start.getTime() - daysBack * DAY);
  const to = new Date(start.getTime() + DAY - 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function parseSearchSources(search: string): SearchSource[] {
  const query = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(query);
  const picked = new Set<string>();
  for (const value of [...params.getAll("source"), ...params.getAll("sources")]) {
    for (const part of value.split(",")) {
      const id = part.trim();
      if ((SEARCH_SOURCES as readonly string[]).includes(id)) picked.add(id);
    }
  }
  return SEARCH_SOURCES.filter((id) => picked.has(id));
}

export function nextSources(current: readonly string[], source: string): SearchSource[] {
  const picked = new Set(current);
  if (picked.has(source)) picked.delete(source);
  else picked.add(source);
  return SEARCH_SOURCES.filter((id) => picked.has(id));
}

export function hasActiveFilters(sources: readonly string[], range: SearchRange): boolean {
  return sources.length > 0 || range !== "all";
}

export function suggestionNames(
  topics: readonly { name: string; lastActive?: string | null }[],
  limit = 4,
): string[] {
  const sorted = [...topics].sort((left, right) => (right.lastActive ?? "").localeCompare(left.lastActive ?? ""));
  const seen = new Set<string>();
  const names: string[] = [];
  for (const topic of sorted) {
    const name = topic.name.trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}

const KEYWORD_FALLBACK_CODES = new Set(["MODEL_UNAVAILABLE_KEYWORD_FALLBACK", "EMBED_UNAVAILABLE"]);

/** Keyword mode is a fault only when the backend says the model fell back. Turning semantic search off does not. */
export function keywordFallbackWarned(
  searchMode: "semantic" | "keyword",
  warnings: readonly { code?: string; message: string }[],
): boolean {
  if (searchMode !== "keyword") return false;
  return warnings.some((warning) => warning.code !== undefined && KEYWORD_FALLBACK_CODES.has(warning.code));
}

export function searchNoticeLines(
  input: {
    indexStatus: "fresh" | "stale";
    searchMode: "semantic" | "keyword";
    warnings: readonly { code?: string; message: string }[];
  },
  copy: { keyword: string; stale: string },
): string[] {
  const lines: string[] = [];
  if (keywordFallbackWarned(input.searchMode, input.warnings)) lines.push(copy.keyword);
  if (input.indexStatus === "stale") lines.push(copy.stale);
  for (const warning of input.warnings) {
    const message = warning.message.trim();
    if (message === "" || lines.includes(message)) continue;
    lines.push(message);
  }
  return lines;
}

export function joinNotice(lines: readonly string[]): string {
  return lines.join(" · ");
}

/** 3 cells at ≥ 0.75, 2 at ≥ 0.55, 1 above 0. Matches the mock scores 0.86 / 0.61 / 0.44. */
export function relevanceCells(score: number): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(score) || score <= 0) return 0;
  if (score >= 0.75) return 3;
  if (score >= 0.55) return 2;
  return 1;
}

export function formatScore(score: number): string {
  if (!Number.isFinite(score)) return "0.00";
  return score.toFixed(2);
}

export interface HighlightPart {
  text: string;
  mark: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function highlightParts(text: string, query: string): HighlightPart[] {
  const tokens = [...new Set(query.trim().split(/\s+/u).filter((token) => token.length > 0))];
  if (tokens.length === 0 || text === "") return [{ text, mark: false }];
  const pattern = new RegExp(tokens.map(escapeRegExp).join("|"), "giu");
  const parts: HighlightPart[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const found = match[0];
    const at = match.index ?? 0;
    if (found.length === 0) break;
    if (at > last) parts.push({ text: text.slice(last, at), mark: false });
    parts.push({ text: found, mark: true });
    last = at + found.length;
  }
  if (last === 0) return [{ text, mark: false }];
  if (last < text.length) parts.push({ text: text.slice(last), mark: false });
  return parts;
}

export function flattenExcerpt(excerpt: string): string {
  return excerpt.replace(/\s+/gu, " ").trim();
}
