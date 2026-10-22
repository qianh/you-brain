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

/** Passages per ONNX call. Keeps the worker peak under the daemon budget. */
export const EMBED_PASSAGE_BATCH = 8;

/**
 * Character cap applied before the model tokenizer. Normal chunks are a few
 * hundred heuristic tokens, so this does not change their vectors. The model
 * still truncates at its own max length.
 */
export const EMBED_MAX_CHARS = 16_384;

export function clampEmbedText(text: string, maxChars = EMBED_MAX_CHARS): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

export function splitEmbedBatches<T>(items: readonly T[], batchSize = EMBED_PASSAGE_BATCH): T[][] {
  if (batchSize < 1) throw new Error("embed batch size must be positive");
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}

export function normalizeVector(vector: number[]): number[] {
  const norm = Math.hypot(...vector);
  return norm === 0 ? [...vector] : vector.map((value) => value / norm);
}
