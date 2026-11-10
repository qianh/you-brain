export type EmbedWorkerMethod =
  | "prepare"
  | "embedQuery"
  | "embedPassages"
  | "shutdown";

export interface EmbedWorkerRequest {
  id: number;
  method: EmbedWorkerMethod;
  model: string;
  revision: string;
  dimensions: number;
  cacheDir: string;
  text?: string;
  texts?: string[];
}

export interface EmbedWorkerResponse {
  id: number;
  ok: boolean;
  error?: string;
  /** Machine-readable failure kind, e.g. `MODEL_DOWNLOAD`. */
  code?: string;
  vector?: number[];
  vectors?: number[][];
}
