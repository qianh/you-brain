import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

async function resolveWritePath(
  path: string,
  visited = new Set<string>(),
): Promise<string> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isEnoent(error)) return path;
    throw error;
  }
  if (!metadata.isSymbolicLink()) return path;
  const identity = resolve(path);
  if (visited.has(identity)) throw new Error("Symlink cycle detected");
  visited.add(identity);
  const target = await readlink(path);
  return resolveWritePath(resolve(dirname(path), target), visited);
}

export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options?: { mode?: number },
): Promise<void> {
  const writePath = await resolveWritePath(path);
  await mkdir(dirname(writePath), { recursive: true });
  const temporaryPath = `${writePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, data, { mode: options?.mode ?? 0o600 });
    await rename(temporaryPath, writePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
