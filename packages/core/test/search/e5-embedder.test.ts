import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, mock } from "bun:test";

const pipeline = mock(() => Promise.resolve(async () => ({ tolist: () => [[1, 0, 0]] })));

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
