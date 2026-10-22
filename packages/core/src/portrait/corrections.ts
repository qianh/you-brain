import type { Event } from "@you-brain/protocol";

import type { PortraitCorrectionView } from "../http/types.js";

/** How many corrections a list response returns. Newest first. */
export const CORRECTION_VIEW_LIMIT = 50;

export interface ClassifiedCorrection {
  correctionId: string;
  variant: string;
  section: string;
  text: string;
  createdAt: string;
  eventId: string;
  status: "pending" | "applied";
  snapshot?: string;
}

/**
 * One row per correction id. The earliest `portrait.correction` wins the text.
 * Any `portrait.correction_applied` with the same id marks it applied, and the
 * latest applied event supplies the snapshot.
 */
export function classifyPortraitCorrections(events: readonly Event[]): ClassifiedCorrection[] {
  const ordered = [...events].sort(compareEvents);
  const snapshots = new Map<string, string>();
  for (const event of ordered) {
    if (event.type !== "portrait.correction_applied") continue;
    snapshots.set(event.data.correctionId, event.data.snapshot);
  }
  const rows: ClassifiedCorrection[] = [];
  const seen = new Set<string>();
  for (const event of ordered) {
    if (event.type !== "portrait.correction") continue;
    if (seen.has(event.data.correctionId)) continue;
    seen.add(event.data.correctionId);
    const snapshot = snapshots.get(event.data.correctionId);
    const row: ClassifiedCorrection = {
      correctionId: event.data.correctionId,
      variant: event.data.variant,
      section: event.data.section,
      text: event.data.text,
      createdAt: event.ts,
      eventId: event.id,
      status: snapshot === undefined ? "pending" : "applied",
    };
    if (snapshot !== undefined) row.snapshot = snapshot;
    rows.push(row);
  }
  return rows;
}

export function portraitCorrectionViews(
  events: readonly Event[],
  variant?: string,
): PortraitCorrectionView[] {
  return classifyPortraitCorrections(events)
    .filter((item) => variant === undefined || item.variant === variant)
    .sort(compareNewest)
    .slice(0, CORRECTION_VIEW_LIMIT)
    .map(toView);
}

export function compareEvents(
  left: { ts: string; id: string },
  right: { ts: string; id: string },
): number {
  return left.ts.localeCompare(right.ts) || left.id.localeCompare(right.id);
}

function compareNewest(left: ClassifiedCorrection, right: ClassifiedCorrection): number {
  return right.createdAt.localeCompare(left.createdAt) || right.eventId.localeCompare(left.eventId);
}

function toView(item: ClassifiedCorrection): PortraitCorrectionView {
  const view: PortraitCorrectionView = {
    correctionId: item.correctionId,
    variant: item.variant,
    section: item.section,
    text: item.text,
    createdAt: item.createdAt,
    status: item.status,
  };
  if (item.snapshot !== undefined) view.snapshot = item.snapshot;
  return view;
}
