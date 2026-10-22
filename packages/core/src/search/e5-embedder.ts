import { loadPackage } from "../native/resolver.js";
import {
  clampEmbedText,
  normalizeVector,
  splitEmbedBatches,
  type Embedder,
} from "./embedder.js";
import { markModelReady } from "./model-cache.js";

/** CPU only. `auto` on macOS includes CoreML and shows up as a large IOAccelerator region. */
const CPU_SESSION: {
  executionProviders: string[];
  intraOpNumThreads: number;
  interOpNumThreads: number;
} = {
  executionProviders: ["cpu"],
  intraOpNumThreads: 2,
  interOpNumThreads: 1,
};

interface TensorOutput {
  tolist(): number[][];
}

type Extractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: true },
) => Promise<TensorOutput>;

type Pipeline = (
  task: "feature-extraction",
  model: string,
  options: {
    revision: string;
    dtype: "q8";
    cache_dir: string;
    device: "cpu";
    session_options: {
      executionProviders: string[];
      intraOpNumThreads: number;
      interOpNumThreads: number;
    };
    progress_callback?: (value: ModelProgress) => void;
  },
) => Promise<Extractor>;

function pipelineFrom(loaded: unknown): Pipeline {
  const record = loaded as { pipeline?: unknown; default?: { pipeline?: unknown } };
  if (typeof record.pipeline === "function") return record.pipeline as Pipeline;
  if (typeof record.default?.pipeline === "function") return record.default.pipeline as Pipeline;
  throw new Error("无法加载 @huggingface/transformers");
}

interface ModelProgress {
  status?: string;
  progress?: number;
  file?: string;
}

export class E5Embedder implements Embedder {
  readonly model: string;
  readonly revision: string;
  readonly dimensions: number;
  readonly #cacheDir: string;
  #extractor: Promise<Extractor> | null = null;
  #readyMarker: Promise<void> | null = null;

  constructor(options: {
    model: string;
    revision: string;
    dimensions: number;
    cacheDir: string;
  }) {
    this.model = options.model;
    this.revision = options.revision;
    this.dimensions = options.dimensions;
    this.#cacheDir = options.cacheDir;
  }

  async #load(
    progress?: (value: { percent?: number; file?: string }) => void,
  ): Promise<Extractor> {
    this.#extractor ??= loadPackage("@huggingface/transformers", () =>
      import("@huggingface/transformers"),
    ).then((loaded) =>
      pipelineFrom(loaded)("feature-extraction", this.model, {
      revision: this.revision,
      dtype: "q8",
      cache_dir: this.#cacheDir,
      device: "cpu",
      session_options: CPU_SESSION,
      ...(progress
        ? {
            progress_callback: (value: ModelProgress) => {
              if (!value.status?.startsWith("progress")) return;
              progress({
                ...(typeof value.progress === "number"
                  ? { percent: value.progress }
                  : {}),
                ...(value.file ? { file: value.file } : {}),
              });
            },
          }
        : {}),
      }),
    );
    try {
      const extractor = await this.#extractor;
      this.#readyMarker ??= markModelReady(this.#cacheDir, {
        model: this.model,
        revision: this.revision,
        dimensions: this.dimensions,
      });
      await this.#readyMarker;
      return extractor;
    } catch (error) {
      this.#extractor = null;
      this.#readyMarker = null;
      throw error;
    }
  }

  async prepare(
    progress?: (value: { percent?: number; file?: string }) => void,
  ): Promise<void> {
    await this.#load(progress);
  }

  async #embed(texts: string[]): Promise<number[][]> {
    const extractor = await this.#load();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist().map((vector) => {
      if (vector.length !== this.dimensions) {
        throw new Error(
          `Embedding dimensions mismatch: expected ${this.dimensions}, received ${vector.length}`,
        );
      }
      return normalizeVector(vector);
    });
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.#embed([`query: ${clampEmbedText(text)}`]);
    if (!vector) throw new Error("Embedding model returned no query vector");
    return vector;
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const vectors: number[][] = [];
    for (const batch of splitEmbedBatches(texts.map((text) => clampEmbedText(text)))) {
      vectors.push(...(await this.#embed(batch.map((text) => `passage: ${text}`))));
    }
    return vectors;
  }
}
