import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { isModelReady, markModelReady } from "../../src/search/model-cache.js";

describe("model cache marker", () => {
  it("is ready only for the marked identity", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "you-brain-model-"));
    const identity = {
      model: "test/model",
      revision: "revision-1",
      dimensions: 3,
    };

    expect(await isModelReady(cacheDir, identity)).toBe(false);
    await markModelReady(cacheDir, identity);
    expect(await isModelReady(cacheDir, identity)).toBe(true);
    expect(
      await isModelReady(cacheDir, { ...identity, revision: "revision-2" }),
    ).toBe(false);
  });
});
