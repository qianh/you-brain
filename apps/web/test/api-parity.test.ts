import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

// The web client and the mock daemon must not call routes the real daemon lacks.
// A mock-only route once hid a missing `google-login` handler behind a working dev page.
const root = join(import.meta.dir, "..", "..", "..");

function apiPaths(file: string): string[] {
  const text = readFileSync(join(root, file), "utf8");
  const found = new Set<string>();
  for (const match of text.matchAll(/"(\/api\/[^"$?]+)"/gu)) {
    const path = match[1];
    if (path) found.add(path);
  }
  return [...found].sort();
}

const daemonPaths = new Set(apiPaths("packages/core/src/http/handlers.ts"));

describe("route parity with the real daemon", () => {
  test("daemon routes are found", () => {
    expect(daemonPaths.size).toBeGreaterThan(15);
    expect(daemonPaths.has("/api/actions/google-login")).toBe(true);
    expect(daemonPaths.has("/api/actions/google-logout")).toBe(true);
    expect(daemonPaths.has("/api/actions/google-switch")).toBe(true);
  });

  test("every path the web client calls exists in the daemon", () => {
    const missing = apiPaths("apps/web/src/api/client.ts").filter((path) => !daemonPaths.has(path));
    expect(missing).toEqual([]);
  });

  test("every path the mock daemon serves exists in the daemon", () => {
    const missing = apiPaths("apps/web/scripts/mock-daemon.ts").filter((path) => !daemonPaths.has(path));
    expect(missing).toEqual([]);
  });
});
