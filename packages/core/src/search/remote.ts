/** Device folder of an inbox path: `inbox/<device>/...`. */
export function deviceOfInboxPath(path: string): string {
  return path.split("/")[1] ?? "";
}

/** Search terms Drive full-text and this excerpt both use: whitespace-separated, case-insensitive. */
export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/u).filter(Boolean);
}

/** A window of the transcript around the first matching term, without the frontmatter. */
export function excerptAround(markdown: string, terms: readonly string[], width = 360): string {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/u, "").replace(/\s+/gu, " ").trim();
  const lower = body.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return body.slice(0, width);
  const start = Math.max(0, at - Math.floor(width / 4));
  return body.slice(start, start + width);
}
