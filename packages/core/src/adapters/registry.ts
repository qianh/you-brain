import type { NormalizedSession } from "../domain/session.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { geminiAdapter } from "./gemini.js";
import { grokAdapter } from "./grok.js";
import type { SourceAdapter } from "./types.js";

const registry = new Map<string, SourceAdapter>();

export function registerAdapter(adapter: SourceAdapter): void {
  registry.set(adapter.id, adapter);
}

export function unregisterAdapter(id: string): void {
  registry.delete(id);
}

export function getAdapter(id: string): SourceAdapter | undefined {
  return registry.get(id);
}

export function listAdapters(): SourceAdapter[] {
  return [...registry.values()];
}

export function continuationOf(
  session: NormalizedSession,
  known: readonly NormalizedSession[] = [],
): string | null {
  const adapter = registry.get(session.source);
  return adapter?.continuationOf?.(session, known) ?? null;
}

registerAdapter(claudeAdapter);
registerAdapter(codexAdapter);
registerAdapter(grokAdapter);
registerAdapter(cursorAdapter);
registerAdapter(geminiAdapter);
