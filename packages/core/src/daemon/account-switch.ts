import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

import { revokeGoogleCredential, type SecretStore } from "../auth/index.js";

const REVOKE_TIMEOUT_MS = 5_000;

/**
 * Drops the stored Google grant. Revoking at Google is best effort: offline or a
 * Google error must not keep the user signed in here. The local credential is
 * deleted either way. Returns whether Google confirmed the revocation.
 */
export async function signOutGoogle(options: {
  secrets: SecretStore;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): Promise<boolean> {
  let revoked = false;
  const serialized = await options.secrets.get().catch(() => null);
  if (serialized) {
    const fetcher = options.fetcher ?? fetch;
    const timeout = options.timeoutMs ?? REVOKE_TIMEOUT_MS;
    try {
      const withTimeout = Object.assign(
        (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          fetcher(input, { ...init, signal: AbortSignal.timeout(timeout) }),
        { preconnect: () => undefined },
      ) as typeof fetch;
      revoked = await revokeGoogleCredential(serialized, withTimeout);
    } catch {
      revoked = false;
    }
  }
  await options.secrets.delete();
  return revoked;
}

const STATE_SUFFIXES = ["", "-wal", "-shm"] as const;

/**
 * Moves the local state database (and its WAL files) into `backups/state-<stamp>/`.
 * Nothing is deleted, so a switch can be undone by hand. The database must be closed.
 * Returns the backup directory, or null when there was no state file.
 */
export async function moveStateAside(options: {
  dataDir: string;
  stateFile: string;
  now: Date;
}): Promise<string | null> {
  const stamp = options.now.toISOString().replaceAll(":", "-").replace(/\.\d+Z$/u, "Z");
  const target = join(options.dataDir, "backups", `state-${stamp}`);
  let moved = false;
  for (const suffix of STATE_SUFFIXES) {
    const source = `${options.stateFile}${suffix}`;
    try {
      await mkdir(target, { recursive: true });
      await rename(source, join(target, `state.sqlite${suffix}`));
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return moved ? target : null;
}
