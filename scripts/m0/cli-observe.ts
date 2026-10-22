import type { CliId } from "./cli-plan.ts";

export interface TextFile {
  path: string;
  text: string;
}

/** Adapter ids come from transcript files. stdout ids come from the CLI's JSON. */
export interface SessionObservation {
  adapterIds: string[];
  stdoutIds: string[];
  parentIds: string[];
  files: string[];
}

export interface SessionComparison {
  adapterIdChanged: boolean | null;
  stdoutIdChanged: boolean | null;
  addedAdapterIds: string[];
  removedAdapterIds: string[];
  addedFiles: string[];
  removedFiles: string[];
  parentPointsAtPreviousAdapterId: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function add(list: string[], value: string | null): void {
  if (value && !list.includes(value)) list.push(value);
}

function jsonValues(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // JSONL falls through.
    }
  }
  const values: unknown[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const item = line.trim();
    if (!item.startsWith("{") && !item.startsWith("[")) continue;
    try {
      values.push(JSON.parse(item) as unknown);
    } catch {
      // Ignore prose and partial lines.
    }
  }
  return values;
}

function fileStem(path: string, suffix: string): string | null {
  const base = path.split("/").pop() ?? "";
  if (!base.endsWith(suffix) || base.length === suffix.length) return null;
  return base.slice(0, -suffix.length);
}

/** Id the adapter would use when the file has no id field. */
export function adapterIdFromPath(cli: CliId, path: string): string | null {
  if (cli === "codex") return /^rollout-.*\.jsonl$/u.test(path.split("/").pop() ?? "") ? fileStem(path, ".jsonl") : null;
  if (cli === "cursor") return fileStem(path, ".jsonl");
  if (cli === "gemini-cli") {
    const base = path.split("/").pop() ?? "";
    return /^session-.*\.json$/u.test(base) ? fileStem(path, ".json") : null;
  }
  if (cli === "grok-build") {
    const parts = path.split("/");
    const base = parts.at(-1);
    if (base !== "chat_history.jsonl" && base !== "summary.json") return null;
    const parent = parts.at(-2);
    return parent && parent !== "." && parent !== "" ? parent : null;
  }
  return null;
}

function collectAdapterId(cli: CliId, value: unknown, ids: string[]): boolean {
  const record = asRecord(value);
  if (!record) return false;
  if (cli === "claude-code") {
    const id = stringField(record, "sessionId");
    add(ids, id);
    return id !== null;
  }
  if (cli === "codex" && record.type === "session_meta") {
    const payload = asRecord(record.payload);
    const id = payload ? stringField(payload, "id") : null;
    add(ids, id);
    return id !== null;
  }
  if (cli === "gemini-cli") {
    const id = stringField(record, "sessionId");
    add(ids, id);
    return id !== null;
  }
  return false;
}

function collectStdoutId(cli: CliId, value: unknown, ids: string[]): void {
  if (cli === "cursor") return;
  const record = asRecord(value);
  if (!record) return;
  add(ids, stringField(record, "session_id"));
  add(ids, stringField(record, "sessionId"));
  if (cli === "codex" && record.type === "session_meta") {
    const payload = asRecord(record.payload);
    if (payload) add(ids, stringField(payload, "id"));
  }
}

function collectParent(cli: CliId, value: unknown, parentIds: string[]): void {
  const record = asRecord(value);
  if (!record) return;
  if (cli === "codex" && record.type === "session_meta") {
    const payload = asRecord(record.payload);
    if (payload) add(parentIds, stringField(payload, "forked_from_id"));
  }
  if (cli === "grok-build") add(parentIds, stringField(record, "parent_session_id"));
}

export function observeSession(cli: CliId, stdout: string, files: readonly TextFile[]): SessionObservation {
  const adapterIds: string[] = [];
  const stdoutIds: string[] = [];
  const parentIds: string[] = [];
  for (const value of jsonValues(stdout)) {
    collectStdoutId(cli, value, stdoutIds);
    collectParent(cli, value, parentIds);
  }
  for (const file of files) {
    let found = false;
    for (const value of jsonValues(file.text)) {
      if (collectAdapterId(cli, value, adapterIds)) found = true;
      collectParent(cli, value, parentIds);
    }
    if (!found) add(adapterIds, adapterIdFromPath(cli, file.path));
  }
  return { adapterIds, stdoutIds, parentIds, files: files.map((file) => file.path) };
}

function changed(before: readonly string[], after: readonly string[]): boolean | null {
  if (before.length === 0 || after.length === 0) return null;
  if (before.length !== after.length) return true;
  const seen = new Set(after);
  return before.some((id) => !seen.has(id));
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const seen = new Set(right);
  return left.filter((id) => !seen.has(id));
}

export function compareSessionObservations(before: SessionObservation, after: SessionObservation): SessionComparison {
  return {
    adapterIdChanged: changed(before.adapterIds, after.adapterIds),
    stdoutIdChanged: changed(before.stdoutIds, after.stdoutIds),
    addedAdapterIds: difference(after.adapterIds, before.adapterIds),
    removedAdapterIds: difference(before.adapterIds, after.adapterIds),
    addedFiles: difference(after.files, before.files),
    removedFiles: difference(before.files, after.files),
    parentPointsAtPreviousAdapterId: after.parentIds.some((id) => before.adapterIds.includes(id)),
  };
}

/** Id to pass to a CLI that resumes by session id. Gemini's plan uses `latest` instead. */
export function resumeSessionId(observation: SessionObservation): string | null {
  const shared = observation.stdoutIds.find((id) => observation.adapterIds.includes(id));
  if (shared) return shared;
  if (observation.adapterIds.length === 1) return observation.adapterIds[0] ?? null;
  if (observation.stdoutIds.length === 1) return observation.stdoutIds[0] ?? null;
  return observation.adapterIds.at(-1) ?? observation.stdoutIds.at(-1) ?? null;
}
