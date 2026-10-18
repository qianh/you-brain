import { readdir as readdirCb, type Dirent } from "node:fs";

import fg from "fast-glob";

/**
 * fast-glob 3.3 has no AbortSignal. Once shutdown flips the signal, later
 * readdir calls return nothing so a walk of a large session tree can drain
 * without waiting for the rest of the disk.
 */
function abortableReaddir(signal: AbortSignal) {
  function readdir(filepath: string, callback: (error: NodeJS.ErrnoException | null, files: string[]) => void): void;
  function readdir(
    filepath: string,
    options: { withFileTypes: true },
    callback: (error: NodeJS.ErrnoException | null, files: Dirent[]) => void,
  ): void;
  function readdir(
    filepath: string,
    optionsOrCallback:
      | { withFileTypes: true }
      | ((error: NodeJS.ErrnoException | null, files: string[]) => void),
    callback?: (error: NodeJS.ErrnoException | null, files: Dirent[]) => void,
  ): void {
    if (typeof optionsOrCallback === "function") {
      if (signal.aborted) {
        optionsOrCallback(null, []);
        return;
      }
      readdirCb(filepath, optionsOrCallback);
      return;
    }
    if (!callback) return;
    if (signal.aborted) {
      callback(null, []);
      return;
    }
    readdirCb(filepath, optionsOrCallback, callback);
  }
  return readdir;
}

export async function globFiles(patterns: string[], signal?: AbortSignal): Promise<string[]> {
  if (patterns.length === 0 || signal?.aborted) return [];
  const options = {
    absolute: true,
    onlyFiles: true,
    unique: true,
    followSymbolicLinks: false,
    suppressErrors: true,
  } as const;
  if (!signal) return fg(patterns, options);
  return fg(patterns, { ...options, fs: { readdir: abortableReaddir(signal) } });
}
