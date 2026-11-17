import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One reply the user sent from the reminder popup. Stays on this machine. */
export interface ReminderReplyRecord {
  reminderId: string;
  topicId: string | null;
  sessionKey: string | null;
  text: string;
  ts: string;
}

export const REMINDER_REPLY_MAX_LINES = 500;
export const REMINDER_REPLY_TEXT_MAX = 500;

/**
 * Appends one JSON line (file mode 0600); past the cap only the newest lines stay.
 * Replies are local by design: the reminder itself travels the protocol, the user's
 * answer does not need to reach other devices for the popup to work.
 */
export function createReminderReplyLog(path: string): (record: ReminderReplyRecord) => void {
  let lines: number | null = null;
  return (record) => {
    mkdirSync(dirname(path), { recursive: true });
    if (lines === null) {
      lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0;
    }
    appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    lines += 1;
    if (lines <= REMINDER_REPLY_MAX_LINES) return;
    const kept = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-REMINDER_REPLY_MAX_LINES);
    writeFileSync(path, `${kept.join("\n")}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    lines = kept.length;
  };
}

/** Newest line wins when the same reminder was answered twice. */
export function readReminderReplies(path: string): ReminderReplyRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, ReminderReplyRecord>();
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null) continue;
      const body = value as Partial<ReminderReplyRecord>;
      if (typeof body.reminderId !== "string" || body.reminderId === "") continue;
      if (typeof body.text !== "string" || body.text.trim() === "") continue;
      byId.set(body.reminderId, {
        reminderId: body.reminderId,
        topicId: typeof body.topicId === "string" ? body.topicId : null,
        sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : null,
        text: body.text.trim().slice(0, REMINDER_REPLY_TEXT_MAX),
        ts: typeof body.ts === "string" ? body.ts : "",
      });
    } catch {
      // A torn line is skipped; the rest of the file still reads.
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.ts < right.ts ? -1 : left.ts > right.ts ? 1 : 0,
  );
}
