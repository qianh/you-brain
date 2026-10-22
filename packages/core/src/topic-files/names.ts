import { topicDetailPath, topicHistoryPath } from "@you-brain/protocol";

import { sha256Hex } from "../drive/hash.js";

/** Manifest key for the overview. A topic id of the same text is stored separately. */
export const OVERVIEW_MANIFEST_KEY = "__overview";

const RESERVED_STEMS = new Set(["", ".", "..", "TOPICS-latest"]);

/**
 * Topic files are named by topic id, not the title. Renames keep the Drive link.
 * Only `[A-Za-z0-9._-]` is kept; every other code point becomes `_`.
 */
export function sanitizeTopicFileName(topicId: string): string {
  let out = "";
  for (const char of topicId) {
    out += /[A-Za-z0-9._-]/u.test(char) ? char : "_";
  }
  return out;
}

export function topicIdDigest8(topicId: string): string {
  return sha256Hex(Buffer.from(topicId, "utf8")).slice(0, 8);
}

export function isPublishableStem(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    name !== "TOPICS-latest" &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

/**
 * Stable file stem for each topic id.
 * A sanitized collision, or a stem Drive would reject, gets `-<8 hex sha256>`.
 */
export function assignTopicFileStems(topicIds: readonly string[]): Map<string, string> {
  const ids = [...new Set(topicIds)];
  const baseOf = new Map<string, string>();
  const grouped = new Map<string, string[]>();
  for (const id of ids) {
    const base = sanitizeTopicFileName(id);
    baseOf.set(id, base);
    const list = grouped.get(base);
    if (list) list.push(id);
    else grouped.set(base, [id]);
  }
  const preferred = new Map<string, string>();
  for (const id of ids) {
    const base = baseOf.get(id) ?? "_";
    const crowded = (grouped.get(base)?.length ?? 0) > 1 || RESERVED_STEMS.has(base);
    preferred.set(id, crowded ? `${base}-${topicIdDigest8(id)}` : base);
  }
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const id of [...ids].sort()) {
    const base = baseOf.get(id) ?? "_";
    let stem = preferred.get(id) ?? `topic-${topicIdDigest8(id)}`;
    if (used.has(stem) || !isPublishableStem(stem)) {
      const full = sha256Hex(Buffer.from(id, "utf8"));
      const prefix = isPublishableStem(base) ? base : "topic";
      stem = `${prefix}-${full}`;
      let n = 2;
      while (used.has(stem) || !isPublishableStem(stem)) {
        stem = `${prefix}-${full}-${n}`;
        n += 1;
      }
    }
    used.add(stem);
    result.set(id, stem);
  }
  return result;
}

/** Names to try when adopting a file whose stem may have changed after a collision. */
export function candidateTopicStems(topicId: string, chosen: string): string[] {
  const base = sanitizeTopicFileName(topicId);
  const names = [chosen, base, `${base}-${topicIdDigest8(topicId)}`];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    if (seen.has(name) || !isPublishableStem(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

export function topicZonePath(zone: "active" | "history", stem: string): string {
  if (!isPublishableStem(stem)) {
    throw new Error(`Unsafe topic file name: ${stem}`);
  }
  return zone === "history" ? topicHistoryPath(stem) : topicDetailPath(stem);
}

export function topicManifestKey(topicId: string): string {
  return topicId === OVERVIEW_MANIFEST_KEY ? "topic:__overview" : topicId;
}

export function topicIdFromManifestKey(key: string): string | null {
  if (key === OVERVIEW_MANIFEST_KEY) return null;
  if (key === "topic:__overview") return OVERVIEW_MANIFEST_KEY;
  return key;
}
