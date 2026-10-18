export type Language = "zh" | "en";

const SOURCE_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "grok-build": "Grok",
  cursor: "Cursor",
  "gemini-cli": "Gemini CLI",
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
    if (id === "brief") return "Brief";
    if (id === "coding") return "Coding";
    return id;
  }
  if (id === "full") return "全量";
  if (id === "brief") return "精简";
  if (id === "coding") return "编码";
  return id;
}

export function weekdayName(day: number, language: Language): string {
  const zh = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const en = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const table = language === "zh" ? zh : en;
  return table[day] ?? String(day);
}

export const LLM_PROVIDER_IDS = [
  "deepseek",
  "glm",
  "qwen",
  "kimi",
  "openai",
  "claude",
  "ollama",
  "custom",
] as const;

export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

export function providerNeedsKey(provider: string): boolean {
  return provider !== "ollama";
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
  return provider;
}
