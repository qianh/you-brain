import fg from "fast-glob";

export async function globFiles(patterns: string[]): Promise<string[]> {
  if (patterns.length === 0) return [];
  return fg(patterns, {
    absolute: true,
    onlyFiles: true,
    unique: true,
    followSymbolicLinks: false,
    suppressErrors: true,
  });
}
