export { chunkText, type TextChunk } from "./chunk-text.js";
export type { SearchDrive, SearchDriveChanges, SearchDriveEntry, SearchDriveObject } from "./drive.js";
export {
  E5_SMALL,
  EMBED_MAX_CHARS,
  EMBED_PASSAGE_BATCH,
  clampEmbedText,
  normalizeVector,
  splitEmbedBatches,
  type Embedder,
} from "./embedder.js";
export { inboxScopePrefixes, inScope } from "./scope.js";
export { serveEmbedWorker } from "./embed-worker.js";
export type { EmbedWorkerRequest, EmbedWorkerResponse } from "./embed-protocol.js";
export { isModelReady, markModelReady, type ModelIdentity } from "./model-cache.js";
export {
  DEFAULT_EMBED_IDLE_MS,
  ProcessEmbedder,
  embedWorkerCommand,
  type IdleClock,
  type ProcessEmbedderOptions,
} from "./process-embedder.js";
export { redactText, type RedactionOptions, type RedactionResult } from "./redact.js";
export { ensureSearchSchema, SEARCH_DRIVE_CURSOR } from "./schema.js";
export {
  BACKFILL_CHUNK_BATCH,
  SearchService,
  type SearchOutput,
  type SearchStatus,
} from "./search-service.js";
export {
  assertSearchRange,
  parseSearchRange,
  updatedAtInRange,
  type ParsedSearchRange,
} from "./time-range.js";
