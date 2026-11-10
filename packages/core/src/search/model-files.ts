import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { E5_SMALL } from "./embedder.js";
import type { ModelIdentity } from "./model-cache.js";

/**
 * Model files are fetched here, not by transformers.js. The library is then
 * pointed at the local directory with remote access off, so loading a model
 * that is already on disk never touches the network.
 */

export interface ModelFile {
  /** Path inside the model repository, with forward slashes. */
  path: string;
  size?: number;
  sha256?: string;
}

/** What a q8 feature-extraction pipeline reads. */
const DEFAULT_FILES: ModelFile[] = [
  { path: "config.json" },
  { path: "tokenizer.json" },
  { path: "tokenizer_config.json" },
  { path: "onnx/model_quantized.onnx" },
];

const PINNED_FILES: Record<string, ModelFile[]> = {
  [`${E5_SMALL.model}@${E5_SMALL.revision}`]: [
    {
      path: "config.json",
      size: 658,
      sha256: "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
    },
    {
      path: "tokenizer.json",
      size: 17_082_730,
      sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
    },
    {
      path: "tokenizer_config.json",
      size: 443,
      sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
    },
    {
      path: "onnx/model_quantized.onnx",
      size: 118_308_185,
      sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
    },
  ],
};

const OFFICIAL_HOST = "https://huggingface.co";
/** Tried in order. A mirror is only used for files with a pinned hash. */
export const MODEL_HOSTS: readonly string[] = [OFFICIAL_HOST, "https://hf-mirror.com"];

/** No bytes for this long ends one attempt, so a dead connection cannot hang a download. */
const DOWNLOAD_STALL_MS = 30_000;

export const MODEL_DOWNLOAD_CODE = "MODEL_DOWNLOAD";

/** The model is not on disk yet and could not be fetched, or is still being fetched. */
export class ModelDownloadError extends Error {
  readonly code = MODEL_DOWNLOAD_CODE;

  constructor(message: string) {
    super(message);
    this.name = "ModelDownloadError";
  }
}

export function isModelDownloadError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === MODEL_DOWNLOAD_CODE
  );
}

export function modelFilesFor(identity: Pick<ModelIdentity, "model" | "revision">): ModelFile[] {
  return PINNED_FILES[`${identity.model}@${identity.revision}`] ?? DEFAULT_FILES;
}

/** Same layout transformers.js used for its own cache, so earlier downloads are reused. */
export function modelDir(
  cacheDir: string,
  identity: Pick<ModelIdentity, "model" | "revision">,
): string {
  return join(cacheDir, ...identity.model.split("/"), identity.revision);
}

function localPath(directory: string, file: ModelFile): string {
  return join(directory, ...file.path.split("/"));
}

async function present(directory: string, file: ModelFile): Promise<boolean> {
  try {
    const info = await stat(localPath(directory, file));
    if (!info.isFile()) return false;
    return file.size === undefined ? info.size > 0 : info.size === file.size;
  } catch {
    return false;
  }
}

/** Files that are absent or have the wrong size. Cheap: no hashing. */
export async function missingModelFiles(
  cacheDir: string,
  identity: Pick<ModelIdentity, "model" | "revision">,
): Promise<ModelFile[]> {
  const directory = modelDir(cacheDir, identity);
  const missing: ModelFile[] = [];
  for (const file of modelFilesFor(identity)) {
    if (!(await present(directory, file))) missing.push(file);
  }
  return missing;
}

export interface EnsureModelFilesOptions {
  fetch?: typeof fetch;
  hosts?: readonly string[];
  stallMs?: number;
  signal?: AbortSignal;
  progress?: (value: { percent?: number; file?: string }) => void;
}

const inFlight = new Map<string, Promise<string>>();

/**
 * Returns the local model directory, downloading whatever is missing first.
 * With every file on disk this makes no network request.
 */
export async function ensureModelFiles(
  cacheDir: string,
  identity: Pick<ModelIdentity, "model" | "revision">,
  options: EnsureModelFilesOptions = {},
): Promise<string> {
  const directory = modelDir(cacheDir, identity);
  const missing = await missingModelFiles(cacheDir, identity);
  if (missing.length === 0) return directory;
  const running = inFlight.get(directory);
  if (running) return running;
  const download = downloadFiles(directory, identity, missing, options).finally(() => {
    inFlight.delete(directory);
  });
  inFlight.set(directory, download);
  return download;
}

async function downloadFiles(
  directory: string,
  identity: Pick<ModelIdentity, "model" | "revision">,
  missing: ModelFile[],
  options: EnsureModelFilesOptions,
): Promise<string> {
  const hosts = options.hosts ?? MODEL_HOSTS;
  const total = missing.every((file) => file.size !== undefined)
    ? missing.reduce((sum, file) => sum + (file.size ?? 0), 0)
    : undefined;
  let finished = 0;
  for (const file of missing) {
    // Without a pinned hash there is nothing to check a mirror's bytes against.
    const candidates = file.sha256 ? hosts : hosts.slice(0, 1);
    const failures: string[] = [];
    let done = false;
    for (const host of candidates) {
      const url = `${host}/${identity.model}/resolve/${identity.revision}/${file.path}`;
      try {
        await downloadOne(url, localPath(directory, file), file, options, (bytes) => {
          options.progress?.({
            file: file.path,
            ...(total ? { percent: ((finished + bytes) / total) * 100 } : {}),
          });
        });
        done = true;
        break;
      } catch (error) {
        if (options.signal?.aborted) {
          throw new ModelDownloadError("embedding model download was cancelled");
        }
        failures.push(`${host}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!done) {
      throw new ModelDownloadError(
        `could not download ${identity.model}/${file.path} (${failures.join("; ")})`,
      );
    }
    finished += file.size ?? 0;
  }
  return directory;
}

async function downloadOne(
  url: string,
  target: string,
  file: ModelFile,
  options: EnsureModelFilesOptions,
  onBytes: (bytes: number) => void,
): Promise<void> {
  const stallMs = options.stallMs ?? DOWNLOAD_STALL_MS;
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watch = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, stallMs);
  };
  await mkdir(dirname(target), { recursive: true });
  // The file only appears under its real name once it is complete and verified.
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "w");
  let closed = false;
  try {
    watch();
    const response = await (options.fetch ?? fetch)(url, {
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      watch();
      hash.update(chunk);
      await handle.write(chunk);
      bytes += chunk.byteLength;
      onBytes(bytes);
    }
    await handle.close();
    closed = true;
    if (file.size !== undefined && bytes !== file.size) {
      throw new Error(`expected ${file.size} bytes, received ${bytes}`);
    }
    if (bytes === 0) throw new Error("empty response");
    if (file.sha256 !== undefined && hash.digest("hex") !== file.sha256) {
      throw new Error("sha256 mismatch");
    }
    await rename(temporary, target);
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    if (stalled) throw new Error(`no data for ${stallMs} ms`);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

/**
 * Deletes files whose content no longer matches the pinned hash, so the next
 * load downloads them again. Returns the removed paths.
 */
export async function removeCorruptModelFiles(
  cacheDir: string,
  identity: Pick<ModelIdentity, "model" | "revision">,
): Promise<string[]> {
  const directory = modelDir(cacheDir, identity);
  const removed: string[] = [];
  for (const file of modelFilesFor(identity)) {
    if (file.sha256 === undefined) continue;
    const path = localPath(directory, file);
    let digest: string;
    try {
      digest = createHash("sha256").update(await readFile(path)).digest("hex");
    } catch {
      continue;
    }
    if (digest === file.sha256) continue;
    await rm(path, { force: true }).catch(() => undefined);
    removed.push(file.path);
  }
  return removed;
}
