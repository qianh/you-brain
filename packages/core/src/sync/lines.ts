export interface LineSelection {
  lines: string[];
  next: number;
  reset: boolean;
}

/** Logical JSONL records. A trailing newline does not create an extra record. */
export function logicalLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Lines after `readLines`. A cursor past the end, or a file that got shorter,
 * falls back to the whole file.
 */
export function selectNewLines(text: string, readLines: number): LineSelection {
  const lines = logicalLines(text);
  if (!Number.isSafeInteger(readLines) || readLines < 0 || readLines > lines.length) {
    return { lines, next: lines.length, reset: true };
  }
  return { lines: lines.slice(readLines), next: lines.length, reset: false };
}
