import type { RedactionOptions } from "../capture/redact.js";
import type { NormalizedSession, SessionSource } from "../domain/session.js";
import type { CapturePathFilter } from "./filter.js";

export const DEFAULT_TOOL_CALL_MAX_CHARS = 2_000;

export interface CaptureOptions {
  device: string;
  /** Keep subagent / sidechain sessions. Default false. */
  includeSubagents?: boolean;
  /** Keep tool-call names and arguments, truncated. Default false. */
  keepToolCalls?: boolean;
  /** Maximum characters retained for each tool call. */
  toolCallMaxChars?: number;
  /** Redact credentials before the session is returned. Default true. */
  redact?: boolean;
  redaction?: RedactionOptions;
}

export interface ResolvedCaptureOptions {
  device: string;
  includeSubagents: boolean;
  keepToolCalls: boolean;
  toolCallMaxChars: number;
  redact: boolean;
  redaction: RedactionOptions;
}

export function resolveCaptureOptions(
  options: CaptureOptions,
): ResolvedCaptureOptions {
  const requested = options.toolCallMaxChars ?? DEFAULT_TOOL_CALL_MAX_CHARS;
  return {
    device: options.device,
    includeSubagents: options.includeSubagents ?? false,
    keepToolCalls: options.keepToolCalls ?? false,
    toolCallMaxChars:
      Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0,
    redact: options.redact ?? true,
    redaction: options.redaction ?? {},
  };
}

export interface AdapterOptions {
  device: string;
  includeSubagents: boolean;
  keepToolCalls?: boolean;
  toolCallMaxChars?: number;
}

export interface AdapterResult {
  session: NormalizedSession | null;
  skippedSubagent: boolean;
  malformedLines: number;
}

export interface SourceFile {
  path: string;
  source: string;
}

export interface SourceAdapter {
  id: string;
  defaultRoots(homeDir?: string): string[];
  discover(roots: string[]): AsyncIterable<SourceFile>;
  parse(
    file: SourceFile,
    opts: CaptureOptions,
  ): Promise<NormalizedSession[]>;
  continuationOf?(
    session: NormalizedSession,
    known?: readonly NormalizedSession[],
  ): string | null;
}

export interface DiscoveryOptions {
  device: string;
  includeSubagents: boolean;
  sources: SessionSource[];
  paths: {
    claude: string[];
    codex: string[];
    grok: string[];
    cursor: string[];
    gemini?: string[];
  };
  modifiedAfter?: Partial<Record<SessionSource, string>>;
  includePaths?: string[];
  /** Keep tool-call names and arguments. Default false, same as adapter parse. */
  keepToolCalls?: boolean;
  toolCallMaxChars?: number;
  /** Redact after parse. Omitted leaves the adapter text unchanged. */
  redact?: boolean;
  redaction?: RedactionOptions;
  sourceFilters?: Partial<Record<SessionSource, CapturePathFilter>>;
}

export interface DiscoveryStatus {
  discovered: number;
  captured: number;
  skippedSubagents: number;
  malformed: number;
  errors: number;
}

export interface DiscoveryResult {
  sessions: NormalizedSession[];
  skippedSubagents: number;
  malformed: number;
  warnings: Array<{ code: string; message: string }>;
  status: Record<
    "claude" | "codex" | "grok" | "cursor" | "gemini",
    DiscoveryStatus
  >;
}

export function adapterOptions(options: CaptureOptions): AdapterOptions {
  const resolved = resolveCaptureOptions(options);
  return {
    device: resolved.device,
    includeSubagents: resolved.includeSubagents,
    keepToolCalls: resolved.keepToolCalls,
    toolCallMaxChars: resolved.toolCallMaxChars,
  };
}

export function toolCallLimit(options: AdapterOptions): number {
  return options.toolCallMaxChars ?? DEFAULT_TOOL_CALL_MAX_CHARS;
}
