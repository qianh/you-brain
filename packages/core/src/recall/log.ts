import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { RecallGrade, RecallKind } from "./types.js";

export const RECALL_LOG_MAX_LINES = 2_000;

/** One consideration, for tuning how loose or tight the reminders are. Stays on this machine. */
export interface RecallLogEntry {
  ts: string;
  sessionKey: string;
  topicId: string | null;
  outcome:
    | "no-topic"
    | "no-memory"
    | "muted"
    | "silent"
    | "issued"
    | "suppressed"
    | "superseded"
    | "duplicate"
    | "failed"
    | "gave-up";
  grade?: RecallGrade;
  kind?: RecallKind;
  reason?: string;
  text?: string;
}

/** Appends one JSON line (file mode 0600); past 2,000 lines only the newest 2,000 stay. */
export function createRecallLog(path: string): (entry: RecallLogEntry) => void {
  let lines: number | null = null;
  return (entry) => {
    mkdirSync(dirname(path), { recursive: true });
    if (lines === null) {
      lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0;
    }
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    lines += 1;
    if (lines <= RECALL_LOG_MAX_LINES) return;
    const kept = readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-RECALL_LOG_MAX_LINES);
    writeFileSync(path, `${kept.join("\n")}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    lines = kept.length;
  };
}
