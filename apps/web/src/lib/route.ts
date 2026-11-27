export const SETTINGS_SECTIONS = [
  "account",
  "model",
  "capture",
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
  /** 话题页里要定位的会话。 */
  session: string | null;
}

export function parseSettingsSection(search: string): SettingsSection {
  const value = new URLSearchParams(search).get("section");
  if (value === "devices") return "account";
  if (value === "refine" || value === "consolidation") return "capture";
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
  const session = url.searchParams.get("session");
  return {
    pathname,
    id: id !== null && id !== "" ? id : null,
    section: parseSettingsSection(url.search),
    q: parseSearchQuery(url.search),
    session: session !== null && session !== "" ? session : null,
  };
}

export function settingsHref(section: SettingsSection = "account"): string {
  return `/settings?section=${encodeURIComponent(section)}`;
}

export function searchHref(q: string): string {
  return `/search?q=${encodeURIComponent(q)}`;
}

/** 指挥台地址；带 `pane` 时直达对应 tty7 会话的整屏终端。 */
export function deckPaneHref(pane: number): string {
  return `/deck?pane=${encodeURIComponent(String(pane))}`;
}

export function parseDeckPane(href: string): number | null {
  const raw = readQuery(href, "pane");
  if (raw === null || !/^\d+$/u.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function deckT3ThreadHref(threadUrl: string, deviceId?: string | null): string {
  const params = new URLSearchParams({ t3Thread: threadUrl });
  if (deviceId) params.set("device", deviceId);
  return `/deck?${params.toString()}`;
}

export function t3ThreadFrameUrl(baseUrl: string, threadUrl: string | null, allowLoopbackRemap = false): string {
  if (!threadUrl) return baseUrl;
  try {
    const target = new URL(threadUrl);
    if (target.username || target.password || target.search || target.hash || !/^\/[^/]+\/[^/]+$/u.test(target.pathname)) {
      return baseUrl;
    }
    const base = new URL(baseUrl);
    if (target.origin === base.origin) return target.href;
    if (allowLoopbackRemap && ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
      return new URL(target.pathname, base).href;
    }
  } catch { return baseUrl; }
  return baseUrl;
}

/** 话题页地址;带 `session` 时话题详情会滚到并标出那段会话。 */
export function topicHref(zone: "active" | "history", id?: string, session?: string | null): string {
  const path = zone === "history" ? "/topics/history" : "/topics";
  if (id === undefined || id === "") return path;
  const base = `${path}?id=${encodeURIComponent(id)}`;
  return session ? `${base}&session=${encodeURIComponent(session)}` : base;
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
/**
 * 顶部菜单某项要去的地址：本次运行里去过就回到上次停留的完整地址（含 `?id=` 等），
 * 页面常驻挂载保住了滚动和展开，地址保住选中项；没去过时「记忆」按记住的分段，其余去菜单本身。
 */
export function primaryNavTarget(
  href: string,
  last: ReadonlyMap<string, string>,
  storedMemoryTab: string | null,
): string {
  return last.get(href) ?? (href === MEMORY_NAV ? memoryHref(storedMemoryTab) : href);
}

export function isPrimaryNavActive(pathname: string, href: string): boolean {
  if (href === MEMORY_NAV) return isMemoryPath(pathname);
  if (href === "/topics") return pathname === "/topics" || pathname === "/topics/history";
  return isNavActive(pathname, href);
}
