function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mergeDefaults<T>(defaults: T, patch: unknown): T {
  if (!isPlainObject(defaults) || !isPlainObject(patch)) {
    return structuredClone(patch) as T;
  }
  const merged = structuredClone(defaults) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = merged[key];
    merged[key] =
      isPlainObject(current) && isPlainObject(value)
        ? mergeDefaults(current, value)
        : structuredClone(value);
  }
  return merged as T;
}

export function mergeConfigInput<T>(defaults: T, input: unknown): unknown {
  if (input === undefined) return structuredClone(defaults);
  if (!isPlainObject(input)) return input;
  return mergeDefaults(defaults, input);
}
