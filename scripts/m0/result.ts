export interface M0Result {
  item: string;
  ok: boolean;
  evidence: Record<string, unknown>;
  notes: string[];
}

export function emit(result: M0Result, code: 0 | 1 | 2): never {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(code);
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

export function clip(text: string, max = 2_000): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Drop bearer tokens and Google access tokens before they reach stdout. */
export function redactSecrets(text: string): string {
  return text
    .replace(/ya29\.[A-Za-z0-9_\-]+/gu, "[redacted]")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]");
}
