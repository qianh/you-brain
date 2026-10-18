import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { E5_SMALL } from "../../src/search/embedder.js";

const live = process.env.YOU_BRAIN_SEARCH_MODEL === "1" ? it : it.skip;

describe("E5 embedder integration", () => {
  live(
    "produces a 384-dimensional vector from the pinned model",
    async () => {
      const { E5Embedder } = await import("../../src/search/e5-embedder.js");
      const cacheDir =
        process.env.YOU_BRAIN_MODEL_CACHE ??
        (await mkdtemp(join(tmpdir(), "you-brain-e5-")));
      const embedder = new E5Embedder({ ...E5_SMALL, cacheDir });
      const vector = await embedder.embedQuery("本地语义搜索");
      expect(vector).toHaveLength(384);
      const norm = Math.hypot(...vector);
      expect(norm).toBeGreaterThan(0.9);
      expect(norm).toBeLessThan(1.1);
    },
    180_000,
  );
});
