import type { SessionSource } from "../domain/session.js";

export interface CapturePathFilter {
  include: readonly string[];
  exclude: readonly string[];
}

/** Exclude wins. An empty include list allows every path that was not excluded. */
export function allowCapturePath(
  filePath: string,
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  if (exclude.some((pattern) => pathMatches(normalized, pattern))) return false;
  if (include.length === 0) return true;
  return include.some((pattern) => pathMatches(normalized, pattern));
}

export function captureSourceFilters(
  sources: Partial<Record<SessionSource, CapturePathFilter>>,
): Partial<Record<SessionSource, CapturePathFilter>> {
  const filters: Partial<Record<SessionSource, CapturePathFilter>> = {};
  for (const [id, source] of Object.entries(sources) as Array<
    [SessionSource, CapturePathFilter | undefined]
  >) {
    if (!source) continue;
    if (source.include.length === 0 && source.exclude.length === 0) continue;
    filters[id] = { include: source.include, exclude: source.exclude };
  }
  return filters;
}

function pathMatches(filePath: string, pattern: string): boolean {
  const normalized = pattern.replaceAll("\\", "/");
  if (normalized.length === 0) return false;
  if (/[*?[]/u.test(normalized)) return globToRegExp(normalized).test(filePath);
  if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) {
    const prefix = normalized.replace(/\/+$/u, "");
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  }
  if (!normalized.includes("/")) return filePath.split("/").includes(normalized);
  const prefix = normalized.replace(/\/+$/u, "");
  return filePath === prefix || filePath.endsWith(`/${prefix}`) || filePath.includes(`/${prefix}/`);
}

/** `**` crosses slashes. `*` does not. */
export function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
      if (pattern[index + 1] === "/") index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end > index + 1) {
        source += `[${pattern.slice(index + 1, end)}]`;
        index = end;
        continue;
      }
    }
    source += /[.+^${}()|[\]\\]/u.test(char) ? `\\${char}` : char;
  }
  source += "$";
  return new RegExp(source, "u");
}
