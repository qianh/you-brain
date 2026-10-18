export { chunkText, type TextChunk } from "./chunk-text.js";
export type { SearchDrive, SearchDriveChanges, SearchDriveEntry, SearchDriveObject } from "./drive.js";
export { E5_SMALL, normalizeVector, type Embedder } from "./embedder.js";
export type { EmbedWorkerRequest, EmbedWorkerResponse } from "./embed-protocol.js";
export { isModelReady, markModelReady, type ModelIdentity } from "./model-cache.js";
export {
  ProcessEmbedder,
  embedWorkerCommand,
  type ProcessEmbedderOptions,
} from "./process-embedder.js";
export { redactText, type RedactionOptions, type RedactionResult } from "./redact.js";
export { ensureSearchSchema, SEARCH_DRIVE_CURSOR } from "./schema.js";
export {
  SearchService,
  type SearchOutput,
  type SearchStatus,
} from "./search-service.js";
