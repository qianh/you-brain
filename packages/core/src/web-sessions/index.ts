export const WEB_INBOX_PATH_PREFIX = "inbox/web-";
export const WEB_INBOX_CURSOR_PREFIX = "webinbox:";
export const WEB_SESSION_BATCH = 3;

export interface WebInboxCursorStore {
  getCursor(key: string): string | null;
  setCursor(key: string, value: string): void;
  listCursors(prefix: string): readonly { key: string; value: string }[];
}

export interface WebInboxRecord {
  sessionKey: string;
  fileId: string;
  path: string;
}

export interface WebSessionRow {
  sessionKey: string;
  updatedAt: string | null;
  refinedUpTo: number;
  msgCount: number;
}

export function isWebInboxPath(path: string): boolean {
  return path.startsWith(WEB_INBOX_PATH_PREFIX);
}

function cursorKey(sessionKey: string): string {
  return `${WEB_INBOX_CURSOR_PREFIX}${sessionKey}`;
}

function parseRecord(value: string): { fileId: string; path: string } | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as { fileId?: unknown; path?: unknown };
    if (typeof record.fileId !== "string" || record.fileId.length === 0) return null;
    if (typeof record.path !== "string" || record.path.length === 0) return null;
    return { fileId: record.fileId, path: record.path };
  } catch {
    return null;
  }
}

/** Writes only when fileId or path changed. Returns whether a write happened. */
export function rememberWebInbox(
  cursors: Pick<WebInboxCursorStore, "getCursor" | "setCursor">,
  sessionKey: string,
  entry: { fileId: string; path: string },
): boolean {
  const key = cursorKey(sessionKey);
  const current = cursors.getCursor(key);
  if (current !== null) {
    const parsed = parseRecord(current);
    if (parsed && parsed.fileId === entry.fileId && parsed.path === entry.path) return false;
  }
  cursors.setCursor(key, JSON.stringify({ fileId: entry.fileId, path: entry.path }));
  return true;
}

export function listWebInbox(cursors: Pick<WebInboxCursorStore, "listCursors">): WebInboxRecord[] {
  const records: WebInboxRecord[] = [];
  for (const row of cursors.listCursors(WEB_INBOX_CURSOR_PREFIX)) {
    if (!row.key.startsWith(WEB_INBOX_CURSOR_PREFIX)) continue;
    const sessionKey = row.key.slice(WEB_INBOX_CURSOR_PREFIX.length);
    const parsed = parseRecord(row.value);
    if (sessionKey.length === 0 || !parsed) continue;
    records.push({ sessionKey, fileId: parsed.fileId, path: parsed.path });
  }
  return records;
}

export function isWebSessionIdle(updatedAt: string | null, nowMs: number, idleMs: number): boolean {
  if (!updatedAt) return false;
  const ms = Date.parse(updatedAt);
  if (Number.isNaN(ms)) return false;
  return nowMs - ms >= idleMs;
}

/** Indexed web sessions that are idle and still have unrefined messages. Oldest first. */
export function pendingWebSessions(input: {
  indexed: readonly WebInboxRecord[];
  sessions: readonly WebSessionRow[];
  nowMs: number;
  idleMs: number;
  blocked: (sessionKey: string) => boolean;
}): WebInboxRecord[] {
  const byKey = new Map(input.sessions.map((session) => [session.sessionKey, session]));
  const ready: Array<WebInboxRecord & { updatedAtMs: number }> = [];
  for (const row of input.indexed) {
    const session = byKey.get(row.sessionKey);
    if (!session || session.refinedUpTo >= session.msgCount) continue;
    if (!isWebSessionIdle(session.updatedAt, input.nowMs, input.idleMs)) continue;
    if (input.blocked(row.sessionKey)) continue;
    const updatedAtMs = Date.parse(session.updatedAt ?? "");
    if (Number.isNaN(updatedAtMs)) continue;
    ready.push({ ...row, updatedAtMs });
  }
  // Newest first: a conversation the user just finished should show up as a topic
  // within a minute, not after a year of archived web sessions. An older backlog only
  // waits longer, which costs nothing.
  ready.sort(
    (left, right) => right.updatedAtMs - left.updatedAtMs || left.sessionKey.localeCompare(right.sessionKey),
  );
  return ready.map(({ sessionKey, fileId, path }) => ({ sessionKey, fileId, path }));
}

/** Sessions still short of their indexed message count. Idle and backoff are ignored. */
export function countUnrefinedWebSessions(
  indexed: readonly { sessionKey: string }[],
  sessions: readonly { sessionKey: string; refinedUpTo: number; msgCount: number }[],
): number {
  const byKey = new Map(sessions.map((session) => [session.sessionKey, session]));
  let count = 0;
  for (const row of indexed) {
    const session = byKey.get(row.sessionKey);
    if (session && session.refinedUpTo < session.msgCount) count += 1;
  }
  return count;
}
