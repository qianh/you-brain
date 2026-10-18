export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^\uFEFF/u, "");
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(body) as unknown;
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(body.slice(start, end + 1)) as unknown;
    }
    throw new Error("模型输出不是 JSON");
  }
}
