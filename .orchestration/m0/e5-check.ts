import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

import { env, pipeline } from "@huggingface/transformers";

const cacheDir = process.env.M0_CACHE;
if (!cacheDir) {
  console.log(JSON.stringify({ ok: false, error: "M0_CACHE is required" }));
  process.exit(1);
}
mkdirSync(cacheDir, { recursive: true });

const mirror = process.env.HF_ENDPOINT;
if (mirror) {
  env.remoteHost = mirror.endsWith("/") ? mirror : `${mirror}/`;
}

const model = "Xenova/multilingual-e5-small";
const revision = "ae61bf0193ce3851dc8a45147e459b04ed783d8a";
const require = createRequire(import.meta.url);

let onnxruntime: string | null = null;
try {
  onnxruntime = require.resolve("onnxruntime-node");
} catch (error) {
  onnxruntime = error instanceof Error ? error.message : String(error);
}

const started = Date.now();
try {
  const extractor = await (
    pipeline as unknown as (
      task: "feature-extraction",
      model: string,
      options: {
        revision: string;
        dtype: "q8";
        cache_dir: string;
      },
    ) => Promise<
      (
        texts: string[],
        options: { pooling: "mean"; normalize: true },
      ) => Promise<{ tolist(): number[][] }>
    >
  )("feature-extraction", model, {
    revision,
    dtype: "q8",
    cache_dir: cacheDir,
  });
  const output = await extractor(["query: bun compile check"], {
    pooling: "mean",
    normalize: true,
  });
  const vector = output.tolist()[0];
  if (!vector) throw new Error("model returned no vector");
  const norm = Math.hypot(...vector);
  const result = {
    ok: vector.length === 384 && Number.isFinite(norm) && norm > 0.5,
    model,
    revision,
    dimensions: vector.length,
    norm,
    sample: vector.slice(0, 4),
    elapsedMs: Date.now() - started,
    execPath: process.execPath,
    argv0: process.argv[0],
    cwd: process.cwd(),
    cacheDir,
    remoteHost: env.remoteHost,
    onnxruntime,
    compiledHint: !process.execPath.endsWith("/bun"),
  };
  console.log(JSON.stringify(result));
  if (!result.ok) process.exit(1);
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      model,
      revision,
      elapsedMs: Date.now() - started,
      execPath: process.execPath,
      cwd: process.cwd(),
      cacheDir,
      remoteHost: env.remoteHost,
      onnxruntime,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    }),
  );
  process.exit(1);
}
