export interface Embedder {
  readonly model: string;
  readonly revision: string;
  readonly dimensions: number;
  embedQuery(text: string): Promise<number[]>;
  embedPassages(texts: string[]): Promise<number[][]>;
}

export const E5_SMALL = {
  model: "Xenova/multilingual-e5-small",
  revision: "ae61bf0193ce3851dc8a45147e459b04ed783d8a",
  dimensions: 384,
} as const;

export function normalizeVector(vector: number[]): number[] {
  const norm = Math.hypot(...vector);
  return norm === 0 ? [...vector] : vector.map((value) => value / norm);
}
