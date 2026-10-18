import type { Database } from "bun:sqlite";

const indexToken = /[\p{Script=Han}]|[\p{L}\p{N}_]+/gu;
const queryToken = /[\p{Script=Han}]{2,}|[\p{L}\p{N}_]{2,}/gu;

export function chunkKey(driveFileId: string, chunkId: string): string {
  return `${driveFileId}\0${chunkId}`;
}

export function indexBody(text: string): string {
  return [...text.matchAll(indexToken)].map((match) => match[0]).join(" ");
}

export function matchExpression(query: string): string | null {
  const tokens = [...query.matchAll(queryToken)].map((match) => match[0]);
  if (tokens.length === 0) return null;
  return tokens
    .map((token) => {
      const phrase = /^\p{Script=Han}+$/u.test(token)
        ? [...token].join(" ")
        : token;
      return `"${phrase.replaceAll('"', '""')}"`;
    })
    .join(" OR ");
}

interface FtsRow {
  drive_file_id: string;
  chunk_id: string;
  rank: number;
}

export function keywordScores(
  database: Database,
  query: string,
): Map<string, number> {
  const expression = matchExpression(query);
  const scores = new Map<string, number>();
  if (!expression) return scores;
  let rows: FtsRow[];
  try {
    rows = database
      .prepare(
        `
        SELECT drive_file_id, chunk_id, bm25(search_chunks_fts) AS rank
        FROM search_chunks_fts
        WHERE search_chunks_fts MATCH ?
      `,
      )
      .all(expression) as FtsRow[];
  } catch {
    return scores;
  }
  let max = 0;
  const weighted = rows.map((row) => {
    const weight = Number.isFinite(row.rank) ? -row.rank : 0;
    if (weight > max) max = weight;
    return { row, weight };
  });
  for (const { row, weight } of weighted) {
    const score = max > 0 ? weight / max : 1;
    const key = chunkKey(row.drive_file_id, row.chunk_id);
    const previous = scores.get(key) ?? 0;
    if (score > previous) scores.set(key, score);
  }
  return scores;
}
