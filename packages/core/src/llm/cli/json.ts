export const CLI_JSON_INSTRUCTION =
  "只输出符合以下 JSON Schema 的 JSON，不要任何其他文字";

export function appendSchemaInstruction(user: string, schema: object): string {
  return `${user}\n\n${CLI_JSON_INSTRUCTION}\n${JSON.stringify(schema)}`;
}

function scanObject(source: string): string | null {
  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (char === "\\") {
          escape = true;
          continue;
        }
        if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const slice = source.slice(start, index + 1);
          try {
            JSON.parse(slice);
            return slice;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

/** First complete JSON object, preferring a ```json fence when one is present. */
export function extractFirstJsonObject(text: string): string | null {
  const fenced: string[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)) {
    const body = match[1];
    if (body) fenced.push(body);
  }
  for (const source of [...fenced, text]) {
    const found = scanObject(source);
    if (found) return found;
  }
  return null;
}

export function jsonText(value: unknown): string | null {
  if (typeof value === "string") return extractFirstJsonObject(value);
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return null;
}
