import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { E5_SMALL } from "../../src/search/embedder.js";
import {
  ensureModelFiles,
  isModelDownloadError,
  missingModelFiles,
  modelDir,
  modelFilesFor,
  removeCorruptModelFiles,
} from "../../src/search/model-files.js";

const unpinned = { model: "test/model", revision: "revision-1" };

async function cacheDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "you-brain-model-files-"));
}

function serving(
  body: (url: string) => string | null,
  calls: string[] = [],
): { fetch: typeof fetch; calls: string[] } {
  const fake = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const text = body(url);
    return text === null ? new Response("missing", { status: 404 }) : new Response(text);
  }) as unknown as typeof fetch;
  return { fetch: fake, calls };
}

describe("model files", () => {
  it("downloads every missing file and makes no request once they are on disk", async () => {
    const cache = await cacheDir();
    const { fetch: fake, calls } = serving((url) => `content of ${url.split("/").pop()}`);

    const directory = await ensureModelFiles(cache, unpinned, { fetch: fake });

    expect(directory).toBe(modelDir(cache, unpinned));
    expect(calls).toEqual([
      "https://huggingface.co/test/model/resolve/revision-1/config.json",
      "https://huggingface.co/test/model/resolve/revision-1/tokenizer.json",
      "https://huggingface.co/test/model/resolve/revision-1/tokenizer_config.json",
      "https://huggingface.co/test/model/resolve/revision-1/onnx/model_quantized.onnx",
    ]);
    expect(await readFile(join(directory, "onnx", "model_quantized.onnx"), "utf8")).toBe(
      "content of model_quantized.onnx",
    );
    expect(await missingModelFiles(cache, unpinned)).toEqual([]);

    calls.length = 0;
    await ensureModelFiles(cache, unpinned, { fetch: fake });
    expect(calls).toEqual([]);
  });

  it("fails with a download error and leaves no partial file", async () => {
    const cache = await cacheDir();
    const { fetch: fake } = serving((url) => (url.endsWith("config.json") ? "{}" : null));

    const failure = await ensureModelFiles(cache, unpinned, { fetch: fake }).catch(
      (error: unknown) => error,
    );

    expect(isModelDownloadError(failure)).toBe(true);
    expect((failure as Error).message).toMatch(/tokenizer\.json.*HTTP 404/u);
    expect(await readdir(modelDir(cache, unpinned))).toEqual(["config.json"]);
  });

  it("does not ask a mirror for a file without a pinned hash", async () => {
    const cache = await cacheDir();
    const { fetch: fake, calls } = serving(() => null);

    await expect(
      ensureModelFiles(cache, unpinned, {
        fetch: fake,
        hosts: ["https://official.test", "https://mirror.test"],
      }),
    ).rejects.toThrow(/could not download/u);
    expect(calls).toEqual(["https://official.test/test/model/resolve/revision-1/config.json"]);
  });

  it("falls back to the mirror for a pinned file and rejects wrong bytes", async () => {
    const cache = await cacheDir();
    const directory = modelDir(cache, E5_SMALL);
    // Everything except the small config is already in place with the right size.
    for (const file of modelFilesFor(E5_SMALL)) {
      if (file.path === "config.json") continue;
      const path = join(directory, ...file.path.split("/"));
      await mkdir(join(path, ".."), { recursive: true });
      await Bun.write(path, new Uint8Array(file.size ?? 0));
    }
    const { fetch: fake, calls } = serving((url) =>
      url.startsWith("https://official.test") ? null : "x".repeat(658),
    );

    const failure = await ensureModelFiles(cache, E5_SMALL, {
      fetch: fake,
      hosts: ["https://official.test", "https://mirror.test"],
    }).catch((error: unknown) => error);

    expect(calls.map((url) => new URL(url).host)).toEqual(["official.test", "mirror.test"]);
    expect((failure as Error).message).toMatch(/official\.test: HTTP 404; .*mirror\.test: sha256 mismatch/u);
    expect((await missingModelFiles(cache, E5_SMALL)).map((file) => file.path)).toEqual([
      "config.json",
    ]);
  });

  it("gives up on a connection that stops sending data", async () => {
    const cache = await cacheDir();
    const silent = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;

    await expect(
      ensureModelFiles(cache, unpinned, { fetch: silent, stallMs: 20 }),
    ).rejects.toThrow(/no data for 20 ms/u);
  });

  it("removes only the files whose content no longer matches the pinned hash", async () => {
    const cache = await cacheDir();
    const directory = modelDir(cache, E5_SMALL);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "config.json"), "damaged");
    await writeFile(join(directory, "tokenizer_config.json"), "damaged too");
    expect(createHash("sha256").update("damaged").digest("hex")).not.toBe(
      modelFilesFor(E5_SMALL)[0]?.sha256,
    );

    expect(await removeCorruptModelFiles(cache, E5_SMALL)).toEqual([
      "config.json",
      "tokenizer_config.json",
    ]);
    expect(await readdir(directory)).toEqual([]);
  });
});
