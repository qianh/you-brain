import { loadPackage } from "../native/resolver.js";
import {
  clampEmbedText,
  normalizeVector,
  splitEmbedBatches,
  type Embedder,
} from "./embedder.js";
import { markModelReady } from "./model-cache.js";
import { ensureModelFiles, removeCorruptModelFiles } from "./model-files.js";

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
    dtype: "q8";
    device: "cpu";
    local_files_only: true;
    session_options: {
      executionProviders: string[];
      intraOpNumThreads: number;
      interOpNumThreads: number;
    };
  },
) => Promise<Extractor>;

type LoadProgress = (value: { percent?: number; file?: string }) => void;

/**
 * transformers.js looks some files up with its default options, ignoring the
 * ones passed to `pipeline`. Left alone that reaches huggingface.co on every
 * load and writes a cache inside the installed package.
 */
function forbidRemote(loaded: unknown): void {
  const record = loaded as {
    env?: Record<string, unknown>;
    default?: { env?: Record<string, unknown> };
  };
  const env = record.env ?? record.default?.env;
  if (!env) return;
  env.allowRemoteModels = false;
  env.useFSCache = false;
}

function pipelineFrom(loaded: unknown): Pipeline {
  const record = loaded as { pipeline?: unknown; default?: { pipeline?: unknown } };
  if (typeof record.pipeline === "function") return record.pipeline as Pipeline;
  if (typeof record.default?.pipeline === "function") return record.default.pipeline as Pipeline;
  throw new Error("无法加载 @huggingface/transformers");
}

export class E5Embedder implements Embedder {
  readonly model: string;
  readonly revision: string;
  readonly dimensions: number;
  readonly #cacheDir: string;
  readonly #ensureFiles: (progress?: LoadProgress) => Promise<string>;
  #extractor: Promise<Extractor> | null = null;
  #readyMarker: Promise<void> | null = null;

  constructor(options: {
    model: string;
    revision: string;
    dimensions: number;
    cacheDir: string;
    /** Returns the local model directory. Tests replace the download. */
    ensureFiles?: (progress?: LoadProgress) => Promise<string>;
  }) {
    this.model = options.model;
    this.revision = options.revision;
    this.dimensions = options.dimensions;
    this.#cacheDir = options.cacheDir;
    this.#ensureFiles =
      options.ensureFiles ??
      ((progress) =>
        ensureModelFiles(this.#cacheDir, this, progress ? { progress } : {}));
  }

  async #open(progress?: LoadProgress): Promise<Extractor> {
    const directory = await this.#ensureFiles(progress);
    const loaded = await loadPackage("@huggingface/transformers", () =>
      import("@huggingface/transformers"),
    );
    forbidRemote(loaded);
    try {
      return await pipelineFrom(loaded)("feature-extraction", directory, {
        dtype: "q8",
        device: "cpu",
        local_files_only: true,
        session_options: CPU_SESSION,
      });
    } catch (error) {
      // Every file was present, so a failed load points at damaged content.
      await removeCorruptModelFiles(this.#cacheDir, this).catch(() => undefined);
      throw error;
    }
  }

  async #load(progress?: LoadProgress): Promise<Extractor> {
    this.#extractor ??= this.#open(progress);
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

  async prepare(progress?: LoadProgress): Promise<void> {
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
