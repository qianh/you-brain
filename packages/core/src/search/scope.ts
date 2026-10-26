import { inboxDeviceDir } from "@you-brain/protocol";

import { WEB_INBOX_PATH_PREFIX } from "../web-sessions/index.js";

/**
 * Drive paths this device downloads and indexes. Other devices keep their own sessions;
 * this device only syncs their topics and fetches one session when it is opened.
 * Browser-plugin files are needed only by the device that refines them.
 */
export function inboxScopePrefixes(input: { device: string; includeWeb: boolean }): string[] {
  const prefixes: string[] = [];
  try {
    prefixes.push(`${inboxDeviceDir(input.device)}/`);
  } catch {
    // A device name that is not a valid folder name has no uploads to index.
  }
  if (input.includeWeb) prefixes.push(WEB_INBOX_PATH_PREFIX);
  return prefixes;
}

export function inScope(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path.startsWith(prefix));
}
