import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, mock } from "bun:test";

const pipeline = mock((_task: string, _model: string, _options: unknown) =>
  Promise.resolve(async (texts: string[]) => ({
    tolist: () => texts.map(() => [1, 0, 0]),
  })),
);

mock.module("@huggingface/transformers", () => ({
  pipeline,
}));

const { E5Embedder } = await import("../../src/search/e5-embedder.js");
const { isModelReady } = await import("../../src/search/model-cache.js");

describe("E5 model cache completion", () => {
  beforeEach(() => {
    pipeline.mockReset();
  });

  it("marks the configured model ready only after it loads successfully", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "you-brain-model-"));
    const identity = {
      model: "test/model",
      revision: "revision-1",
      dimensions: 3,
    };
    pipeline.mockResolvedValue(async () => ({
      tolist: () => [[1, 0, 0]],
    }));
    const embedder = new E5Embedder({ ...identity, cacheDir });

    expect(await isModelReady(cacheDir, identity)).toBe(false);
    await embedder.prepare();
    expect(await isModelReady(cacheDir, identity)).toBe(true);
    expect(pipeline).toHaveBeenCalledWith(
      "feature-extraction",
      identity.model,
      expect.objectContaining({
        device: "cpu",
        dtype: "q8",
        revision: identity.revision,
        cache_dir: cacheDir,
        session_options: {
          executionProviders: ["cpu"],
          intraOpNumThreads: 2,
          interOpNumThreads: 1,
        },
      }),
    );
  });

  it("embeds passages in capped batches and clamps overlong text", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "you-brain-model-"));
    const batches: string[][] = [];
    pipeline.mockResolvedValue(async (texts: string[]) => {
      batches.push([...texts]);
      return { tolist: () => texts.map(() => [1, 0, 0]) };
    });
    const embedder = new E5Embedder({
      model: "test/model",
      revision: "revision-1",
      dimensions: 3,
      cacheDir,
    });
    const texts = [...Array.from({ length: 9 }, (_, index) => `chunk-${index}`), "y".repeat(20_000)];

    const vectors = await embedder.embedPassages(texts);

    expect(vectors).toHaveLength(10);
    expect(batches.map((batch) => batch.length)).toEqual([8, 2]);
    const last = batches[1]?.[1] ?? "";
    expect(last.startsWith("passage: ")).toBe(true);
    expect(last.length).toBe("passage: ".length + 16_384);
  });

  it("leaves no ready marker when model loading fails", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "you-brain-model-"));
    const identity = {
      model: "test/model",
      revision: "revision-1",
      dimensions: 3,
    };
    pipeline.mockRejectedValue(new Error("incomplete model"));
    const embedder = new E5Embedder({ ...identity, cacheDir });

    await expect(embedder.prepare()).rejects.toThrow(/incomplete model/);
    expect(await isModelReady(cacheDir, identity)).toBe(false);
  });

  it("retries a load after a failure instead of caching the rejection", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "you-brain-model-"));
    const identity = {
      model: "test/model",
      revision: "revision-1",
      dimensions: 3,
    };
    pipeline.mockRejectedValueOnce(new Error("incomplete model"));
    pipeline.mockResolvedValue(async () => ({
      tolist: () => [[1, 0, 0]],
    }));
    const embedder = new E5Embedder({ ...identity, cacheDir });

    await expect(embedder.prepare()).rejects.toThrow(/incomplete model/);
    await embedder.prepare();
    expect(await isModelReady(cacheDir, identity)).toBe(true);
  });
});
