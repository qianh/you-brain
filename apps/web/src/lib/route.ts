export interface AppLocation {
  pathname: string;
  id: string | null;
}

export function parseAppLocation(input: string): AppLocation {
  const url = new URL(input, "http://127.0.0.1");
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  const id = url.searchParams.get("id");
  return { pathname, id: id !== null && id !== "" ? id : null };
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
