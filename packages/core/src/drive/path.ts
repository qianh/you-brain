import { posix } from "node:path";

import { YouBrainError } from "../domain/errors.js";

export function safePath(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\")) {
    throw new YouBrainError(
      "INVALID_INPUT",
      "Drive path must be relative to the Drive root",
    );
  }
  const normalized = posix.normalize(value);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized === "."
  ) {
    throw new YouBrainError("INVALID_INPUT", "Drive path escapes the Drive root");
  }
  return normalized;
}

export function safeName(value: string): string {
  if (
    !value ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".."
  ) {
    throw new YouBrainError("INVALID_INPUT", "Drive file name is invalid");
  }
  return value;
}
