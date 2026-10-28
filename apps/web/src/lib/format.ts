import { LLM_PROVIDERS } from "@you-brain/protocol";

export type Language = "zh" | "en";

const SOURCE_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "grok-build": "Grok",
  cursor: "Cursor",
  "gemini-cli": "Gemini CLI",
  pi: "Pi",
  "t3-code": "T3 Code",
  zcode: "ZCode",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export function formatDateTime(
  iso: string | null,
  language: Language,
  timeZone?: string,
): string {
  if (iso === null || iso.trim() === "") return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const locale = language === "zh" ? "zh-CN" : "en-US";
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  };
  if (timeZone !== undefined && timeZone !== "") options.timeZone = timeZone;
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: string;
  minute: string;
}

export function zonedParts(date: Date, timeZone: string | undefined): ZonedParts {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  if (timeZone !== undefined && timeZone !== "") options.timeZone = timeZone;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", options).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  }
  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: (map.hour ?? "00").padStart(2, "0"),
    minute: (map.minute ?? "00").padStart(2, "0"),
  };
}

function calendarSerial(parts: Pick<ZonedParts, "year" | "month" | "day">): number {
  return parts.year * 10000 + parts.month * 100 + parts.day;
}

function previousCalendarDay(parts: ZonedParts): number {
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.getUTCFullYear() * 10000 + (utc.getUTCMonth() + 1) * 100 + utc.getUTCDate();
}

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function absoluteStamp(parts: ZonedParts, language: Language, withYear: boolean): string {
  const clock = `${parts.hour}:${parts.minute}`;
  if (language === "zh") {
    const date = `${parts.month}月${parts.day}日`;
    return withYear ? `${parts.year}年${date} ${clock}` : `${date} ${clock}`;
  }
  const month = EN_MONTHS[parts.month - 1] ?? String(parts.month);
  return withYear ? `${month} ${parts.day}, ${parts.year}, ${clock}` : `${month} ${parts.day}, ${clock}`;
}

function unit(count: number, language: Language, one: string, many: string): string {
  if (language === "zh") return `${count} ${one}前`;
  return count === 1 ? `1 ${one} ago` : `${count} ${many} ago`;
}

/**
 * 1 分钟内「刚刚」，1 小时内「N 分钟前」，同一天内「N 小时前」，
 * 前一个日历日「昨天 HH:mm」，同年「M月D日 HH:mm」，跨年带年份。
 * `now` 只用于测试。
 */
export function formatRelative(
  iso: string | null,
  language: Language,
  timeZone?: string,
  now: Date | number = Date.now(),
): string {
  if (iso === null || iso.trim() === "") return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const nowDate = typeof now === "number" ? new Date(now) : now;
  const diffMs = nowDate.getTime() - date.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  if (abs < 60_000) return language === "zh" ? "刚刚" : "Just now";
  if (future) {
    const then = zonedParts(date, timeZone);
    const current = zonedParts(nowDate, timeZone);
    return absoluteStamp(then, language, then.year !== current.year);
  }
  if (abs < 3_600_000) {
    const minutes = Math.max(1, Math.floor(abs / 60_000));
    return unit(minutes, language, language === "zh" ? "分钟" : "minute", "minutes");
  }
  const then = zonedParts(date, timeZone);
  const current = zonedParts(nowDate, timeZone);
  if (calendarSerial(then) === calendarSerial(current)) {
    const hours = Math.max(1, Math.floor(abs / 3_600_000));
    return unit(hours, language, language === "zh" ? "小时" : "hour", "hours");
  }
  const clock = `${then.hour}:${then.minute}`;
  if (calendarSerial(then) === previousCalendarDay(current)) {
    return language === "zh" ? `昨天 ${clock}` : `Yesterday ${clock}`;
  }
  return absoluteStamp(then, language, then.year !== current.year);
}

export function formatDay(isoDate: string, language: Language): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(isoDate);
  if (!match) return isoDate;
  const year = match[1] ?? "";
  const month = Number(match[2] ?? "0");
  const day = Number(match[3] ?? "0");
  if (language === "zh") return `${year}年${month}月${day}日`;
  const date = new Date(Date.UTC(Number(year), month - 1, day));
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export interface NamedDevice {
  deviceId: string;
  displayName: string;
}

export function deviceLabel(id: string, devices: readonly NamedDevice[]): string {
  const found = devices.find((device) => device.deviceId === id);
  return found?.displayName ?? id;
}

export function driveFileUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

export function variantName(id: string, language: Language): string {
  if (language === "en") {
    if (id === "full") return "Full";
    if (id === "coding") return "Coding";
    if (id === "projects") return "Projects";
    return id;
  }
  if (id === "full") return "全量";
  if (id === "coding") return "编码";
  if (id === "projects") return "项目";
  return id;
}

export function weekdayName(day: number, language: Language): string {
  const zh = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const en = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const table = language === "zh" ? zh : en;
  return table[day] ?? String(day);
}

export const LLM_PROVIDER_IDS = LLM_PROVIDERS;

export type LlmProviderId = (typeof LLM_PROVIDERS)[number];

export function providerNeedsKey(provider: string): boolean {
  return provider !== "ollama" && !provider.endsWith("-cli");
}

export function providerLabel(provider: string, language: Language): string {
  if (provider === "custom") return language === "zh" ? "自定义兼容接口" : "Custom endpoint";
  if (provider === "claude") return "Claude";
  if (provider === "openai") return "OpenAI";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "glm") return "GLM";
  if (provider === "qwen") return "Qwen";
  if (provider === "kimi") return "Kimi";
  if (provider === "ollama") return "Ollama";
  if (provider === "grok-cli") return language === "zh" ? "Grok（本机订阅）" : "Grok (local subscription)";
  if (provider === "claude-cli") {
    return language === "zh" ? "Claude Code（本机订阅）" : "Claude Code (local subscription)";
  }
  if (provider === "codex-cli") return language === "zh" ? "Codex（本机订阅）" : "Codex (local subscription)";
  if (provider === "gemini-cli") {
    return language === "zh" ? "Gemini CLI（本机订阅）" : "Gemini CLI (local subscription)";
  }
  if (provider === "opencode-cli") {
    return language === "zh" ? "OpenCode（本机订阅）" : "OpenCode (local subscription)";
  }
  return provider;
}
