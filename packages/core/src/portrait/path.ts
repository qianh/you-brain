import { posix } from "node:path";

import { YouBrainError } from "../domain/errors.js";

/**
 * Config paths are relative to the Drive root. A leading `/` is a My Drive
 * absolute path: drop the slash, then drop a configured root prefix such as
 * `brain-hub/`. DrivePort itself rejects a leading slash and is rooted at the
 * you-brain folder, so paths outside that folder cannot be read here.
 */
export function resolveDrivePath(configured: string, driveRoot = ""): string {
  let path = configured.trim().replace(/\\/gu, "/");
  if (!path) throw new YouBrainError("INVALID_INPUT", "Portrait path is empty");
  if (path.startsWith("/")) {
    path = path.replace(/^\/+/u, "");
    const root = driveRoot.trim().replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
    if (root && (path === root || path.startsWith(`${root}/`))) {
      path = path.slice(root.length).replace(/^\/+/u, "");
    }
  }
  const normalized = posix.normalize(path);
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new YouBrainError("INVALID_INPUT", "Portrait path is invalid");
  }
  return normalized;
}

export function globPrefix(pattern: string): string {
  const meta = pattern.search(/[*?]/u);
  const slash = pattern.lastIndexOf("/", meta < 0 ? pattern.length : meta);
  return slash < 0 ? "" : pattern.slice(0, slash + 1);
}

export function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const char of pattern) {
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += /[.+^${}()|[\]\\]/u.test(char) ? `\\${char}` : char;
  }
  source += "$";
  return new RegExp(source, "u");
}
