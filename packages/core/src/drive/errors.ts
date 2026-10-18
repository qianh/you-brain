export class ConflictError extends Error {
  readonly code = 412 as const;
  readonly status = 412 as const;

  constructor(message = "Drive precondition failed") {
    super(message);
    this.name = "ConflictError";
  }
}

export function isConflict(error: unknown): boolean {
  if (error instanceof ConflictError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  return (
    candidate.code === 412 ||
    candidate.status === 412 ||
    candidate.response?.status === 412
  );
}
