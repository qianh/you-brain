import { join } from "node:path";

function quote(path: string): string {
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Read mostly unrestricted, no network, and no access to the user's you-brain
 * data or the installed app. Build artifacts stay readable.
 */
export function sandboxProfile(home: string): string {
  const denied = [
    join(home, ".you-brain"),
    join(home, "Library", "Application Support", "you-brain"),
    "/Applications/you-brain.app",
  ];
  const lines = ["(version 1)", "(allow default)", "(deny network*)"];
  for (const path of denied) {
    lines.push(`(deny file-read* (subpath ${quote(path)}))`);
    lines.push(`(deny file-write* (subpath ${quote(path)}))`);
  }
  return `${lines.join("\n")}\n`;
}
