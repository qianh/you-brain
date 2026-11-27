import { createHash } from "node:crypto";
import { z } from "zod";
import { dingTalkMinutesQuery, dingTalkTaskId, DingTalkMinutesError, type DingTalkMinutesDetail } from "./dingtalk-minutes.js";
import { dingTalkActionKey, dingTalkMinutesSource, MEETING_IMPORT_MAX_ITEMS } from "./meeting-import.js";
import { MEETING_IMPORT_MAX_BYTES, type DingTalkInboxMeeting } from "./types.js";

export const DINGTALK_SYNC_MS = 5 * 60_000;
const time = z.number().int().nonnegative();
const cursor = dingTalkMinutesQuery.shape.cursor.nullable();

export const DingTalkInboxSchema = z.object({
  meetings: z.array(z.object({
    source: dingTalkMinutesSource,
    items: z.array(z.object({ id: dingTalkActionKey, title: z.string().min(1).max(200), description: z.string().min(1).max(3000) })).max(MEETING_IMPORT_MAX_ITEMS),
  })),
  ignored: z.array(dingTalkActionKey),
  checked: z.array(dingTalkTaskId),
  details: z.array(z.object({ taskUuid: dingTalkTaskId, retryAt: time })),
  lastScan: time.optional(),
  scan: z.object({ start: time, end: time, cursors: z.object({ mine: cursor, shared: cursor }) }).optional(),
});

export type DingTalkInbox = z.infer<typeof DingTalkInboxSchema>;

export function newDingTalkScan(lastScan: number | undefined, now: number): NonNullable<DingTalkInbox["scan"]> {
  const overlap = lastScan === undefined ? 24 * 60 * 60_000 : 30 * 60_000;
  const end = Math.max(now, lastScan ?? 0);
  return { start: Math.max(0, (lastScan ?? end) - overlap), end, cursors: {} };
}

export function dingTalkActionItems(detail: DingTalkMinutesDetail, seen: Set<string>): DingTalkInboxMeeting["items"] {
  const items: DingTalkInboxMeeting["items"] = [];
  let bytes = 0;
  for (const action of detail.actions) {
    const heading = action.text.replace(/\s+/gu, " ").trim();
    const id = createHash("sha256").update(JSON.stringify([
      detail.source.taskUuid, action.id ? "id" : "text", action.id ?? heading,
    ])).digest("hex");
    if (seen.has(id)) continue;
    seen.add(id);
    bytes += Buffer.byteLength(action.text, "utf8");
    if (items.length === MEETING_IMPORT_MAX_ITEMS || action.text.length > 3000 || bytes > MEETING_IMPORT_MAX_BYTES) {
      throw new DingTalkMinutesError("DINGTALK_LIMIT");
    }
    items.push({ id, title: heading.length > 200 ? `${heading.slice(0, 199).trimEnd()}…` : heading, description: action.text });
  }
  return items;
}
