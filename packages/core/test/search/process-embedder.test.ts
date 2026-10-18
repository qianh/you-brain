import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  ProcessEmbedder,
  embedWorkerCommand,
} from "../../src/search/process-embedder.js";

const workerSource = `
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    const vector = [1, ...Array.from({ length: request.dimensions - 1 }, () => 0)];
    if (request.method === "embedQuery") {
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, vector }) + "\\n");
      continue;
    }
    if (request.method === "embedPassages") {
      process.stdout.write(JSON.stringify({
        id: request.id,
        ok: true,
        vectors: (request.texts ?? []).map(() => vector),
      }) + "\\n");
      continue;
    }
    if (request.method === "prepare" || request.method === "shutdown") {
      process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + "\\n");
      if (request.method === "shutdown") process.exit(0);
      continue;
    }
    process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: "unknown method" }) + "\\n");
  }
}
`;

describe("process embedder", () => {
  it("points the worker command at the source worker", () => {
    expect(embedWorkerCommand()).toEqual([
      "bun",
      expect.stringMatching(/embed-worker\.ts$/u),
    ]);
  });

  it("embeds through a replaceable subprocess", async () => {
    const directory = await mkdtemp(join(tmpdir(), "you-brain-embed-worker-"));
    const workerPath = join(directory, "fake-embed-worker.ts");
    await writeFile(workerPath, workerSource);
    const embedder = new ProcessEmbedder({
      command: [process.execPath, workerPath],
      model: "subprocess-test",
      revision: "v1",
      dimensions: 3,
      cacheDir: directory,
    });

    try {
      await embedder.prepare();
      expect(await embedder.embedQuery("release")).toEqual([1, 0, 0]);
      expect(await embedder.embedPassages(["a", "b"])).toEqual([
        [1, 0, 0],
        [1, 0, 0],
      ]);
    } finally {
      await embedder.close();
    }
  });

  it("fails when the worker exits before answering", async () => {
    const embedder = new ProcessEmbedder({
      command: [process.execPath, "-e", "process.exit(1)"],
      model: "subprocess-test",
      revision: "v1",
      dimensions: 3,
      cacheDir: tmpdir(),
    });

    try {
      await expect(embedder.embedQuery("release")).rejects.toThrow(/embed worker/);
    } finally {
      await embedder.close();
    }
  });
});
