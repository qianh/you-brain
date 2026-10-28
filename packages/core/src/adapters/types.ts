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
  /**
   * Subscription CLI cwd. Sessions produced there are dropped.
   * Omitted uses the default `<dataDir>/llm-cli`.
   */
  llmCliWorkDir?: string;
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
  /** Stop reading the session file when the daemon is shutting down. */
  signal?: AbortSignal;
  /** Subscription CLI cwd. Sessions produced there are dropped. */
  llmCliWorkDir?: string;
}

export interface AdapterResult {
  session: NormalizedSession | null;
  skippedSubagent: boolean;
  /** Startup noise: injected instructions with no real question, or no reply at all. */
  skippedNoise?: boolean;
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
    pi?: string[];
    t3?: string[];
    zcode?: string[];
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
  /** Aborts directory walks and session reads. Already-aborted returns no sessions. */
  signal?: AbortSignal;
  /**
   * When false, parsed sessions are not stored on the result.
   * Callers that only need `onParsed` use this to avoid retaining every session.
   * Default true.
   */
  retainSessions?: boolean;
  /** Return true to leave this path unread. It still counts as discovered. */
  skipFile?: (path: string) => boolean | Promise<boolean>;
  /** Fired after a file is parsed, including files that yield no session. */
  onParsed?: (
    path: string,
    session: NormalizedSession | null,
  ) => void | Promise<void>;
}

export interface DiscoveryStatus {
  discovered: number;
  captured: number;
  skippedSubagents: number;
  /** Files that held CLI startup context rather than a conversation. */
  skippedNoise: number;
  malformed: number;
  errors: number;
}

export interface DiscoveryResult {
  sessions: NormalizedSession[];
  skippedSubagents: number;
  skippedNoise: number;
  malformed: number;
  warnings: Array<{ code: string; message: string }>;
  status: Record<
    "claude" | "codex" | "grok" | "cursor" | "gemini" | "pi" | "t3" | "zcode",
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
    ...(options.llmCliWorkDir !== undefined ? { llmCliWorkDir: options.llmCliWorkDir } : {}),
  };
}

export function toolCallLimit(options: AdapterOptions): number {
  return options.toolCallMaxChars ?? DEFAULT_TOOL_CALL_MAX_CHARS;
}
