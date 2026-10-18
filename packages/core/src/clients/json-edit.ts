export interface JsonProperty {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

function skipWhitespace(source: string, index: number): number {
  let cursor = index;
  while (cursor < source.length && /\s/u.test(source.charAt(cursor))) cursor += 1;
  return cursor;
}

function parseJsonString(source: string, start: number): { value: string; end: number } {
  if (source.charAt(start) !== '"') throw new SyntaxError("Expected a JSON string");
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (char === "\\") {
      const next = source.charAt(index + 1);
      if (!next) throw new SyntaxError("Unterminated JSON escape");
      if (next === "u") {
        const hex = source.slice(index + 2, index + 6);
        if (!/^[0-9a-fA-F]{4}$/u.test(hex)) throw new SyntaxError("Bad JSON unicode escape");
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 5;
        continue;
      }
      const escaped =
        next === "n"
          ? "\n"
          : next === "t"
            ? "\t"
            : next === "r"
              ? "\r"
              : next === "b"
                ? "\b"
                : next === "f"
                  ? "\f"
                  : next;
      value += escaped;
      index += 1;
      continue;
    }
    if (char === '"') return { value, end: index + 1 };
    value += char;
  }
  throw new SyntaxError("Unterminated JSON string");
}

function matchingBracket(source: string, start: number): number {
  const open = source.charAt(start);
  const close = open === "{" ? "}" : "]";
  if (open !== "{" && open !== "[") throw new SyntaxError("Expected a JSON container");
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (char === '"') {
      index = parseJsonString(source, index).end - 1;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new SyntaxError("Unbalanced JSON");
}

function valueEnd(source: string, start: number): number {
  const char = source.charAt(start);
  if (char === '"') return parseJsonString(source, start).end;
  if (char === "{" || char === "[") return matchingBracket(source, start) + 1;
  if (source.startsWith("true", start)) return start + 4;
  if (source.startsWith("false", start)) return start + 5;
  if (source.startsWith("null", start)) return start + 4;
  let index = start;
  while (index < source.length && !/[\s,}\]]/u.test(source.charAt(index))) index += 1;
  if (index === start) throw new SyntaxError("Expected a JSON value");
  return index;
}

export function objectProperties(source: string, openBrace: number): JsonProperty[] {
  if (source.charAt(openBrace) !== "{") throw new SyntaxError("Expected a JSON object");
  const properties: JsonProperty[] = [];
  let cursor = openBrace + 1;
  while (cursor < source.length) {
    cursor = skipWhitespace(source, cursor);
    if (source.charAt(cursor) === "}") return properties;
    const key = parseJsonString(source, cursor);
    const keyStart = cursor;
    cursor = skipWhitespace(source, key.end);
    if (source.charAt(cursor) !== ":") throw new SyntaxError("Expected ':'");
    const valueStart = skipWhitespace(source, cursor + 1);
    const end = valueEnd(source, valueStart);
    properties.push({
      key: key.value,
      keyStart,
      valueStart,
      valueEnd: end,
    });
    cursor = skipWhitespace(source, end);
    if (source.charAt(cursor) === ",") {
      cursor += 1;
      continue;
    }
    if (source.charAt(cursor) === "}") return properties;
    throw new SyntaxError("Expected ',' or '}'");
  }
  throw new SyntaxError("Unterminated JSON object");
}

function topLevelObject(source: string): number {
  const start = skipWhitespace(source, 0);
  if (source.charAt(start) !== "{") throw new TypeError("JSON configuration must be an object");
  return start;
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function removeProperty(source: string, openBrace: number, key: string): string {
  const properties = objectProperties(source, openBrace);
  const index = properties.findIndex((property) => property.key === key);
  if (index < 0) return source;
  const property = properties[index];
  if (!property) return source;
  const close = matchingBracket(source, openBrace);
  let start = property.keyStart;
  let end = property.valueEnd;
  if (index < properties.length - 1) {
    const after = skipWhitespace(source, property.valueEnd);
    if (source.charAt(after) === ",") end = after + 1;
  } else if (index > 0) {
    const previous = properties[index - 1];
    if (previous) {
      const comma = skipWhitespace(source, previous.valueEnd);
      if (source.charAt(comma) === ",") start = comma;
    }
  }
  const next = source.slice(0, start) + source.slice(end, close) + source.slice(close);
  return next;
}

function insertProperty(source: string, openBrace: number, key: string, rawValue: string): string {
  const properties = objectProperties(source, openBrace);
  const existing = properties.find((property) => property.key === key);
  if (existing) {
    return (
      source.slice(0, existing.valueStart) + rawValue + source.slice(existing.valueEnd)
    );
  }
  const close = matchingBracket(source, openBrace);
  const fragment = `${properties.length === 0 ? "" : ","}\n  ${jsonString(key)}: ${rawValue}`;
  return source.slice(0, close) + fragment + source.slice(close);
}

export function upsertJsonProperty(
  source: string,
  containerKey: string,
  propertyKey: string,
  value: unknown,
): string {
  const parsed = JSON.parse(source.trim() === "" ? "{}" : source) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("JSON configuration must be an object");
  }
  const root = parsed as Record<string, unknown>;
  const container = root[containerKey];
  if (
    container !== undefined &&
    (!container || typeof container !== "object" || Array.isArray(container))
  ) {
    throw new TypeError(`${containerKey} must be a JSON object`);
  }
  const rawValue = JSON.stringify(value, null, 2).replace(/\n/gu, "\n  ");
  if (source.trim() === "") {
    return `${JSON.stringify({ [containerKey]: { [propertyKey]: value } }, null, 2)}\n`;
  }
  const open = topLevelObject(source);
  const properties = objectProperties(source, open);
  const containerProperty = properties.find((property) => property.key === containerKey);
  if (!containerProperty) {
    const containerRaw = JSON.stringify({ [propertyKey]: value }, null, 2).replace(
      /\n/gu,
      "\n  ",
    );
    return `${insertProperty(source, open, containerKey, containerRaw)}\n`.replace(
      /\n$/u,
      source.endsWith("\n") ? "\n" : "\n",
    );
  }
  if (source.charAt(containerProperty.valueStart) !== "{") {
    throw new TypeError(`${containerKey} must be a JSON object`);
  }
  const edited = insertProperty(
    source,
    containerProperty.valueStart,
    propertyKey,
    rawValue,
  );
  JSON.parse(edited);
  return edited.endsWith("\n") || !source.endsWith("\n") ? edited : `${edited}\n`;
}

export function removeJsonProperty(
  source: string,
  containerKey: string,
  propertyKey: string,
): string {
  const parsed = JSON.parse(source) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("JSON configuration must be an object");
  }
  const container = (parsed as Record<string, unknown>)[containerKey];
  if (container === undefined) return source;
  if (!container || typeof container !== "object" || Array.isArray(container)) {
    throw new TypeError(`${containerKey} must be a JSON object`);
  }
  const open = topLevelObject(source);
  const properties = objectProperties(source, open);
  const containerProperty = properties.find((property) => property.key === containerKey);
  if (!containerProperty || source.charAt(containerProperty.valueStart) !== "{") {
    return source;
  }
  const edited = removeProperty(source, containerProperty.valueStart, propertyKey);
  JSON.parse(edited);
  return edited;
}

export function readJsonProperty(
  source: string,
  containerKey: string,
  propertyKey: string,
): unknown {
  const parsed = JSON.parse(source) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("JSON configuration must be an object");
  }
  const container = (parsed as Record<string, unknown>)[containerKey];
  if (container === undefined) return undefined;
  if (!container || typeof container !== "object" || Array.isArray(container)) {
    throw new TypeError(`${containerKey} must be a JSON object`);
  }
  return (container as Record<string, unknown>)[propertyKey];
}
