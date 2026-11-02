import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

import { revokeGoogleCredential, type SecretStore } from "../auth/index.js";

const REVOKE_TIMEOUT_MS = 5_000;

/**
 * Reads the stored Google grant and deletes it. Returns the serialized credential
 * so the caller can tell Google later, without making sign-out wait on the network.
 * Null when nothing was stored.
 */
export async function takeGoogleCredential(secrets: SecretStore): Promise<string | null> {
  const serialized = await secrets.get().catch(() => null);
  await secrets.delete();
  return serialized;
}

/**
 * Asks Google to revoke a grant that is already gone locally. Best effort: offline,
 * a Google error, or cancellation resolves false and never throws.
 */
export function revokeStoredGrant(options: {
  serialized: string | null;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (!options.serialized || options.signal?.aborted) return Promise.resolve(false);
  const fetcher = options.fetcher ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REVOKE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const withTimeout = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      fetcher(input, { ...init, signal }),
    { preconnect: () => undefined },
  ) as typeof fetch;
  return revokeGoogleCredential(options.serialized, withTimeout).catch(() => false);
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
