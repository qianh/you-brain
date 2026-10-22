import { DRIVE_PATHS, IsoTimestampSchema } from "@you-brain/protocol";
import { z } from "zod";

import { YouBrainError } from "../domain/errors.js";
import type { DrivePort } from "../drive/drive-port.js";
import { updateJsonWithMerge, upsertByPath } from "../upload/write.js";

const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const ConsolidateLeaseSchema = z.object({
  date: DaySchema,
  deviceId: z.string().min(1),
  finishedAt: IsoTimestampSchema,
});

export type ConsolidateLease = z.infer<typeof ConsolidateLeaseSchema>;

export function parseConsolidateLease(input: unknown): ConsolidateLease | null {
  const parsed = ConsolidateLeaseSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** Larger `date` wins. The same date keeps the later `finishedAt`. */
export function mergeConsolidateLease(
  current: ConsolidateLease | null,
  incoming: ConsolidateLease,
): ConsolidateLease {
  if (!current) return incoming;
  if (incoming.date > current.date) return incoming;
  if (incoming.date < current.date) return current;
  const incomingMs = Date.parse(incoming.finishedAt);
  const currentMs = Date.parse(current.finishedAt);
  if (Number.isNaN(currentMs) || incomingMs >= currentMs) return incoming;
  return current;
}

export async function readConsolidateLease(
  drive: DrivePort,
  warn: (message: string) => void,
): Promise<ConsolidateLease | null> {
  try {
    const object = await drive.readPath(DRIVE_PATHS.consolidateLease);
    if (!object) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(object.bytes.toString("utf8")) as unknown;
    } catch {
      warn("沉淀租约无法解析，按未沉淀处理");
      return null;
    }
    const lease = parseConsolidateLease(parsed);
    if (!lease) {
      warn("沉淀租约无法解析，按未沉淀处理");
      return null;
    }
    return lease;
  } catch {
    warn("读取沉淀租约失败，按未沉淀处理");
    return null;
  }
}

export async function writeConsolidateLease(
  drive: DrivePort,
  lease: ConsolidateLease,
): Promise<void> {
  const parsed = parseConsolidateLease(lease);
  if (!parsed) throw new YouBrainError("INVALID_INPUT", "沉淀租约无效");
  try {
    await updateJsonWithMerge(drive, DRIVE_PATHS.consolidateLease, (current) =>
      mergeConsolidateLease(parseConsolidateLease(current), parsed),
    );
  } catch (error) {
    if (error instanceof YouBrainError && error.code === "INVALID_INPUT") {
      await upsertByPath(
        drive,
        DRIVE_PATHS.consolidateLease,
        `${JSON.stringify(parsed, null, 2)}\n`,
        { mimeType: "application/json" },
      );
      return;
    }
    throw error;
  }
}
