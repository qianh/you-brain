export const SETTINGS_SECTIONS = [
  "account",
  "model",
  "status",
  "devices",
  "capture",
  "refine",
  "consolidation",
  "portrait",
  "integrations",
  "appearance",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export interface AppLocation {
  pathname: string;
  id: string | null;
  section: SettingsSection;
  q: string | null;
}

export function parseSettingsSection(search: string): SettingsSection {
  const value = new URLSearchParams(search).get("section");
  if (value !== null && (SETTINGS_SECTIONS as readonly string[]).includes(value)) {
    return value as SettingsSection;
  }
  return "account";
}

export function readQuery(href: string, key: string): string | null {
  const index = href.indexOf("?");
  if (index < 0) return null;
  const value = new URLSearchParams(href.slice(index + 1)).get(key);
  if (value === null || value.trim() === "") return null;
  return value;
}

export function parseSearchQuery(search: string): string | null {
  const value = new URLSearchParams(search).get("q");
  if (value === null || value.trim() === "") return null;
  return value;
}

export function parseAppLocation(input: string): AppLocation {
  const url = new URL(input, "http://127.0.0.1");
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  const id = url.searchParams.get("id");
  return {
    pathname,
    id: id !== null && id !== "" ? id : null,
    section: parseSettingsSection(url.search),
    q: parseSearchQuery(url.search),
  };
}

export function settingsHref(section: SettingsSection = "account"): string {
  return `/settings?section=${encodeURIComponent(section)}`;
}

export function searchHref(q: string): string {
  return `/search?q=${encodeURIComponent(q)}`;
}

export function topicHref(zone: "active" | "history", id?: string): string {
  const path = zone === "history" ? "/topics/history" : "/topics";
  if (id === undefined || id === "") return path;
  return `${path}?id=${encodeURIComponent(id)}`;
}

export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/topics") return pathname === "/topics";
  if (href === "/topics/history") return pathname === "/topics/history";
  return pathname === href;
}

/** 「记忆」入口里记住上次停留的分段（今日 / 话题册）的偏好键。 */
export const MEMORY_TAB_KEY = "you-brain.memory.tab";
/** 顶部菜单里「记忆」这一项的标识；它不是页面地址，点击时按 `memoryHref` 决定去哪。 */
export const MEMORY_NAV = "/memory";

/** 记忆入口点开后去哪：记着话题册就去话题册，其余（含没记过）去今日。 */
export function memoryHref(stored: string | null): "/today" | "/topics" {
  return stored === "topics" ? "/topics" : "/today";
}

/** 记忆入口下的三个页面地址。 */
export function isMemoryPath(pathname: string): boolean {
  return pathname === "/today" || pathname === "/topics" || pathname === "/topics/history";
}

/** 顶部菜单某一项是否高亮；「记忆」在今日、话题册、历史三个地址下都高亮。 */
export function isPrimaryNavActive(pathname: string, href: string): boolean {
  if (href === MEMORY_NAV) return isMemoryPath(pathname);
  if (href === "/topics") return pathname === "/topics" || pathname === "/topics/history";
  return isNavActive(pathname, href);
}
