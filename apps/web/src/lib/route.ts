export const SETTINGS_SECTIONS = [
  "account",
  "model",
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

/** The shelf tab covers both the active and history routes. */
export function isPrimaryNavActive(pathname: string, href: string): boolean {
  if (href === "/topics") return pathname === "/topics" || pathname === "/topics/history";
  return isNavActive(pathname, href);
}
