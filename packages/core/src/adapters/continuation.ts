import { createHash } from "node:crypto";

import type { NormalizedSession, Turn } from "../domain/session.js";

export const DEFAULT_CONTINUATION_PREFIX_TURNS = 2;

const nativeParents = new Map<string, string>();

function continuationKey(session: NormalizedSession): string {
  return `${session.source}\0${session.conversationId}`;
}

export function rememberContinuation(
  session: NormalizedSession,
  parentId: string | null,
): void {
  const key = continuationKey(session);
  if (parentId && parentId !== session.conversationId) {
    nativeParents.set(key, parentId);
    return;
  }
  nativeParents.delete(key);
}

export function nativeContinuation(session: NormalizedSession): string | null {
  return nativeParents.get(continuationKey(session)) ?? null;
}

export function clearContinuationIndex(): void {
  nativeParents.clear();
}

export function messagePrefixHash(
  turns: readonly Turn[],
  count: number,
): string {
  const hash = createHash("sha256");
  const slice = turns.slice(0, Math.max(0, count));
  hash.update(String(slice.length));
  hash.update("\0");
  for (const turn of slice) {
    hash.update(turn.role);
    hash.update("\0");
    hash.update(turn.text);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sameTurn(left: Turn, right: Turn): boolean {
  return left.role === right.role && left.text === right.text;
}

function isPrefix(shorter: readonly Turn[], longer: readonly Turn[]): boolean {
  if (shorter.length > longer.length) return false;
  for (let index = 0; index < shorter.length; index += 1) {
    const left = shorter[index];
    const right = longer[index];
    if (!left || !right || !sameTurn(left, right)) return false;
  }
  return true;
}

export function continuationByPrefix(
  session: NormalizedSession,
  known: readonly NormalizedSession[],
  prefixTurns = DEFAULT_CONTINUATION_PREFIX_TURNS,
): string | null {
  if (prefixTurns < 1 || session.turns.length < prefixTurns) return null;
  const hash = messagePrefixHash(session.turns, prefixTurns);
  const candidates = known.filter((candidate) => {
    if (candidate.source !== session.source) return false;
    if (candidate.conversationId === session.conversationId) return false;
    if (candidate.turns.length < prefixTurns) return false;
    if (candidate.turns.length > session.turns.length) return false;
    if (messagePrefixHash(candidate.turns, prefixTurns) !== hash) return false;
    return isPrefix(candidate.turns, session.turns);
  });
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    if (left.turns.length !== right.turns.length) {
      return right.turns.length - left.turns.length;
    }
    const byTime = left.startedAt.localeCompare(right.startedAt);
    if (byTime !== 0) return byTime;
    return left.conversationId.localeCompare(right.conversationId);
  });
  return candidates[0]?.conversationId ?? null;
}

export function resolveContinuation(
  session: NormalizedSession,
  known: readonly NormalizedSession[] = [],
  prefixTurns = DEFAULT_CONTINUATION_PREFIX_TURNS,
): string | null {
  return (
    nativeContinuation(session) ??
    continuationByPrefix(session, known, prefixTurns)
  );
}
