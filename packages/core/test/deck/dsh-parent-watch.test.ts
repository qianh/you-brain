import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const watcher = resolve(import.meta.dir, "../../../../sidecars/dsh-host/parent-watch.mjs");
const node = spawnSync("node", ["--version"]).status === 0 ? "node" : null;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(100);
  }
  return predicate();
}

describe("DSH parent watch", () => {
  // The orphan case: the daemon is killed outright and cannot stop DSH itself.
  it.skipIf(node === null)("exits once its parent is killed, and not before", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yb-watch-"));
    const pidFile = join(dir, "child.pid");
    // The parent starts a long-running child with the watcher preloaded, then just waits.
    const parentScript = join(dir, "parent.mjs");
    await writeFile(parentScript, `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const child = spawn("node", ["--import", ${JSON.stringify(new URL(`file://${watcher}`).href)}, "-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `);
    const parent = spawn("node", [parentScript], { stdio: "ignore" });
    try {
      expect(await until(() => Bun.file(pidFile).size > 0, 5_000)).toBe(true);
      const child = Number(await readFile(pidFile, "utf8"));
      await Bun.sleep(2_500);
      expect(alive(child)).toBe(true);

      parent.kill("SIGKILL");
      expect(await until(() => !alive(child), 8_000)).toBe(true);
    } finally {
      parent.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
