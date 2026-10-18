import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { DaemonLockError, acquireDaemonLock } from "../../src/daemon/lock.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function lockPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "you-brain-lock-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return join(root, "daemon.lock");
}

describe("daemon lock", () => {
  it("rejects a live pid and keeps mode 600", async () => {
    const path = await lockPath();
    const held = await acquireDaemonLock(path);
    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
    const body = JSON.parse(await readFile(path, "utf8")) as { pid: number };
    expect(body.pid).toBe(process.pid);
    await expect(acquireDaemonLock(path)).rejects.toBeInstanceOf(DaemonLockError);
    await expect(acquireDaemonLock(path)).rejects.toThrow(`pid ${process.pid}`);
    await held.release();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("takes over a dead pid and a corrupt file", async () => {
    const path = await lockPath();
    await writeFile(path, `${JSON.stringify({ pid: 99_999_999, startedAt: "" })}\n`);
    const taken = await acquireDaemonLock(path);
    const body = JSON.parse(await readFile(path, "utf8")) as { pid: number };
    expect(body.pid).toBe(process.pid);
    await taken.release();

    await writeFile(path, "not-json");
    const recovered = await acquireDaemonLock(path);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: process.pid });
    await recovered.release();
  });

  it("does not delete the lock when the pid has changed", async () => {
    const path = await lockPath();
    const held = await acquireDaemonLock(path);
    await writeFile(path, `${JSON.stringify({ pid: 99_999_999, startedAt: "" })}\n`);
    await held.release();
    const body = JSON.parse(await readFile(path, "utf8")) as { pid: number };
    expect(body.pid).toBe(99_999_999);
  });
});
