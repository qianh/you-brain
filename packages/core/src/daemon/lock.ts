import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { isProcessAlive } from "../http/daemon-file.js";

export class DaemonLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonLockError";
  }
}

interface LockBody {
  pid: number;
  startedAt: string;
}

/**
 * Exclusive lock under the data directory. A dead pid, or a corrupt file,
 * can be taken over. Release deletes the file only while it still names us.
 */
export async function acquireDaemonLock(
  lockFile: string,
): Promise<{ release(): Promise<void> }> {
  await mkdir(dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(lockFile, "wx", 0o600);
      await chmod(lockFile, 0o600);
      const body: LockBody = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };
      await handle.writeFile(`${JSON.stringify(body)}\n`);
      await handle.close();
      handle = null;
      return {
        async release() {
          const current = await readLock(lockFile);
          if (current?.pid !== process.pid) return;
          await rm(lockFile, { force: true });
        },
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? (error as { code?: string }).code
          : undefined;
      if (code !== "EEXIST") throw error;
      const current = await readLock(lockFile);
      if (current && isProcessAlive(current.pid)) {
        throw new DaemonLockError(
          `you-brain daemon 已在运行（pid ${current.pid}）`,
        );
      }
      await rm(lockFile, { force: true });
    }
  }
  throw new DaemonLockError("无法获取 daemon 锁");
}

async function readLock(lockFile: string): Promise<LockBody | null> {
  let text: string;
  try {
    text = await readFile(lockFile, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as { pid?: unknown };
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return null;
    return { pid: parsed.pid, startedAt: "" };
  } catch {
    return null;
  }
}
