import { watch, type FSWatcher } from "node:fs";
import { access, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import {
  DRIVE_PATHS,
  DEFAULT_UPLOAD_ACTIVE_INTERVAL_MINUTES,
  PROTOCOL_VERSION,
  conversationKey,
  createDefaultRoles,
  createDefaultSharedConfig,
  resolveWebProcessor,
  ulid,
  type Event,
  type EventOf,
  type EventType,
  type Roles,
  type SharedConfig,
} from "@you-brain/protocol";

import {
  captureSourceFilters,
  getAdapter,
  parseSourceFile,
} from "../adapters/index.js";
import {
  clearGoogleConnection,
  clearUserOAuthCredentials,
  createConfigSecretStore,
  createOAuthClientSecretStore,
  getLlmApiKey,
  isUsableOfficialOAuthClient,
  resolveOfficialOAuthClient,
  resolveSecretBackend,
  saveUserOAuthCredentials,
  setLlmApiKey,
  updateUserOAuthClientId,
  type SecretBackend,
} from "../auth/index.js";
import { applyCaptureRedaction } from "../capture/redact.js";
import { renderSessionMarkdown } from "../capture/normalize.js";
import {
  SESSION_SOURCES,
  YouBrainError,
  assertSupportedPlatform,
  loadLocalConfig,
  writeLocalConfig,
  type DeviceRole,
  type LocalConfig,
  type NormalizedSession,
  type SessionSource,
  type YouBrainPaths,
} from "../domain/index.js";
import type { DriveEntry, DrivePort } from "../drive/drive-port.js";
import { isInboxSessionFile } from "../drive/inbox-file.js";
import { HttpError } from "../http/handlers.js";
import { ChangeHub } from "../http/hub.js";
import {
  listPortraitSnapshots,
  readPortraitFile,
} from "../http/portrait-files.js";
import { createStoreReaders } from "../http/queries.js";
import { portraitCorrectionViews } from "../portrait/corrections.js";
import { startDaemonHttp, type DaemonHttpServer } from "../http/server.js";
import type {
  HttpDeps,
} from "../http/deps.js";
import type {
  LlmKeyPutBody,
  LlmTestBody,
  GoogleLoginResult,
  GoogleLogoutResult,
  LlmTestResult,
  OAuthClientPublic,
  OAuthClientPutBody,
  SearchRequest,
  StatusResponse,
  SyncActionResult,
  UploadActionInput,
  UploadActionResult,
  WebhookPublic,
  WebhookPutBody,
  WebhookTestResult,
  ZoneSettings,
} from "../http/types.js";
import { isCliNoOutputTimeout } from "../llm/cli/exec.js";
import {
  LLM_PRESETS,
  createLlmBackend,
  describeLlmSetupFailure,
  isCliProvider,
  LlmRequestError,
  LlmRetryQueue,
  type LlmBackend,
  type LlmSetupWarning,
} from "../llm/index.js";
import { cliUnresponsiveWarning } from "../llm/setup-status.js";
import { OutputService } from "../output/service.js";
import {
  ConsolidationRejected,
  createDrivePortrait,
  emptyConsolidationState,
  executeConsolidation,
  localDayKey,
  mergeSuggestionLines,
  parseMergeSuggestions,
  readConsolidateLease,
  shiftDateKey,
  writeConsolidateLease,
  MERGE_SUGGESTIONS_CURSOR,
  type ConsolidationState,
} from "../consolidate/index.js";
import { dueRemindersForDevice } from "../reminders/run.js";
import { timeZoneOffsetMinutes } from "../reminders/time.js";
import {
  WEBHOOK_STATE_CURSOR,
  applyWebhookUpdate,
  countWebhookPending,
  defaultWebhookConfig,
  emptyWebhookState,
  parseWebhookState,
  postWebhook,
  readWebhookConfig,
  runWebhookDelivery,
  serializeWebhookState,
  webhookConfigPath,
  webhookErrorHost,
  webhookUrlProblem,
  writeWebhookConfig,
  type WebhookConfig,
  type WebhookFetch,
} from "../webhook/index.js";

import { CodingInjection } from "../portrait/injection.js";
import { FilePortraitConsentStore, portraitConsentPath } from "../portrait/consent.js";
import { PortraitService } from "../portrait/service.js";
import {
  createRefineEventFactory,
  defaultRefineIds,
  refineSession,
} from "../refine/index.js";
import type { CandidateTopic, OpenTodo, PreviousRefine } from "../refine/types.js";
import {
  E5_SMALL,
  ProcessEmbedder,
  SearchService,
  assertSearchRange,
  embedWorkerCommand,
  inScope,
  inboxScopePrefixes,
  type Embedder,
  type SearchDrive,
} from "../search/index.js";
import { withSessionCounts } from "./topic-session-count.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { EventLog } from "../sync/event-log.js";
import { readOutboxQueue, writeOutboxQueue } from "../sync/queue.js";
import { ProtocolSync } from "../sync/service.js";
import type { DeviceIdentity } from "../sync/types.js";
import { applyEvents, foldEvents, partitionTopics, persistTopicBook } from "../topics/index.js";
import {
  decideUpload,
  emptySchedule,
  noteActivity,
  noteUpload,
  type ScheduleState,
} from "../upload/schedule.js";
import { UploadService } from "../upload/upload-service.js";
import type { UploadIndex } from "../upload/types.js";
import { NotionService } from "../notion/service.js";
import {
  captureGeneration,
  captureWorkerBinary,
  collectCaptureHits,
  sessionHash,
  type CaptureCursorInput,
  type CaptureHit,
  type CaptureMeta,
  type CaptureScanRequest,
} from "./capture-scan.js";
import {
  type DaemonClock,
  systemDaemonClock,
} from "./clock.js";
import { ACTIVITY_EPOCH, decideDelivery } from "../reminders/delivery.js";
import { allocateCopied, appendCopied } from "./events.js";
import { moveStateAside, signOutGoogle } from "./account-switch.js";
import { openGoogleDrive } from "./google.js";
import { acquireDaemonLock } from "./lock.js";
import { createStartupLog, type StartupLog } from "./startup-log.js";
import {
  preferLocalLlm,
  readRolesFile,
  readSharedFile,
  writeJsonFile,
} from "./local-state.js";
import {
  TOPIC_FILES_MANIFEST,
  emptyTopicFilesResult,
  syncTopicFiles,
  type TopicFilesResult,
} from "../topic-files/sync.js";
import { INTERVALS, intervalDue, pullInterval } from "./schedule.js";
import {
  WEB_SESSION_BATCH,
  WEB_SESSION_CONCURRENCY,
  countUnrefinedWebSessions,
  isWebInboxPath,
  listWebInbox,
  pendingWebSessions,
  rememberWebInbox,
} from "../web-sessions/index.js";
import { frontmatter, parseWebSession } from "../web-sessions/parse.js";
import { describeSyncFailure } from "./sync-error.js";
import type { SecretStore } from "../auth/index.js";

const APP_VERSION = "0.1.0";
const BACKFILL_CURSOR = "capture.backfill";
/** A stuck Drive read must not hold `/api/status` longer than the shell's read timeout. */
const STATUS_DRIVE_WAIT_MS = 1_000;
/** Inbox files downloaded at the same time while draining the index queue. */
const INBOX_READ_CONCURRENCY = 8;
/**
 * How far back the refine backfill reaches.
 *
 * Every session in the window costs one model call, and history deeper than a week
 * mostly adds noise: a library can hold hundreds of short image-generation sessions that
 * would each become a topic of their own without saying anything about the user. The
 * original transcripts are uploaded and searchable regardless — this only limits what
 * gets turned into topics and portrait material.
 */
const REFINE_BACKFILL_WINDOW_DAYS = 7;

/**
 * Cursor key holding the file fingerprint of the last capture scan.
 *
 * Without it, every restart forgets which files were already parsed and re-reads the
 * whole library: a 9,000-file scan takes minutes, and a scan that long starves the
 * upload pass that shares the tick. The fingerprints let a restart skip straight to
 * the files that changed.
 */
const CAPTURE_FILES_CURSOR = "capture.files";

/**
 * Cursor key set when a pull saw `inbox/web-*` files. A device that is not the web
 * processor does not download them, so the status warning about a missing processor
 * cannot rely on the local index.
 */
const WEB_INBOX_SEEN_CURSOR = "webinbox.seen";

/** Cursor key remembering the modified time at which an inbox file was last indexed. */
function inboxIndexedKey(fileId: string): string {
  return `inbox.indexed.${fileId}`;
}

/**
 * Inbox files still waiting to be indexed. Pull advances `sync.drive` before these
 * are read, so the queue has to live in the store or a restart would skip them.
 */
const INBOX_PENDING_CURSOR = "inbox.pending";

interface InboxPendingFile {
  id: string;
  path: string;
  modifiedTime: string;
  mimeType?: string;
}

function readInboxPending(store: SqliteStore): InboxPendingFile[] {
  const raw = store.getCursor(INBOX_PENDING_CURSOR);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const files: InboxPendingFile[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (typeof row.id !== "string" || row.id.length === 0) continue;
      if (typeof row.path !== "string" || typeof row.modifiedTime !== "string") continue;
      const file: InboxPendingFile = {
        id: row.id,
        path: row.path,
        modifiedTime: row.modifiedTime,
      };
      if (typeof row.mimeType === "string") file.mimeType = row.mimeType;
      files.push(file);
    }
    return files;
  } catch {
    return [];
  }
}

function writeInboxPending(store: SqliteStore, files: readonly InboxPendingFile[]): void {
  const body = files.map((file) => {
    const row: InboxPendingFile = {
      id: file.id,
      path: file.path,
      modifiedTime: file.modifiedTime,
    };
    if (file.mimeType !== undefined) row.mimeType = file.mimeType;
    return row;
  });
  store.setCursor(INBOX_PENDING_CURSOR, JSON.stringify(body));
}

function inboxPendingEntry(file: InboxPendingFile): DriveEntry {
  return {
    id: file.id,
    path: file.path,
    mimeType: file.mimeType ?? "text/markdown",
    size: 0,
    createdTime: file.modifiedTime,
    modifiedTime: file.modifiedTime,
    etag: "",
    md5Checksum: "",
    appProperties: {},
  };
}

/** Cursor holding the Google account this device's local data belongs to, set at sign-out. */
const DRIVE_ACCOUNT_CURSOR = "account.drive";
/** Stop proceeds even if Drive or the model probe is still hanging. */
const BACKGROUND_STOP_MS = 3_000;

export interface DaemonOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  hostname?: string;
  /** 首次创建配置时的角色。已存在的 config.toml 以文件里的 role 为准。 */
  role?: DeviceRole;
  clock?: DaemonClock;
  /** `undefined` tries Google Drive. `null` stays unauthorized without touching the keychain. */
  drive?: DrivePort | null;
  /** `undefined` builds a backend from config. `null` skips refine. */
  llm?: LlmBackend | null;
  embedder?: Embedder;
  sourceRoots?: Partial<Record<SessionSource, string[]>>;
  staticDir?: string;
  /** Listen for SIGINT and SIGTERM. Default false so tests can call stop(). */
  signals?: boolean;
  /** Test injection. Shortens subscription CLI calls so a silent hang fails quickly. */
  llmTimeoutMs?: number;
  /** Test injection. Widens the refine window so a test can set up older history. */
  refineBackfillWindowDays?: number;
  secrets?: SecretStore;
  appVersion?: string;
  /** Default true. Tests set false so discovery is driven only by scan() and the 10 minute timer. */
  watch?: boolean;
  port?: number;
  /** Test injection. Defaults to the global fetch. Tests must not open a real connection. */
  webhookFetch?: WebhookFetch;
  /** Test injection. Defaults to openGoogleDrive. Tests must not open a browser. */  googleOpen?: typeof openGoogleDrive;
  /** Test injection. Defaults to the global fetch. Tests must not reach Google. */
  revokeFetch?: typeof fetch;
}

interface LiveSession {
  source: SessionSource;
  conversationId: string;
  device: string;
  startedAt: string;
  updatedAt: string;
  sourcePath: string;
  turnCount: number;
  hash: string;
  schedule: ScheduleState;
  includeSubagents: boolean;
  keepToolCalls: boolean;
  redact: boolean;
}

interface CaptureFileCursor {
  stamp: string;
  key: string | null;
  generation: string;
  /**
   * Session metadata recorded with the fingerprint. Restoring it puts the session back
   * in the live map after a restart, so an unchanged file is neither re-parsed nor
   * uploaded again.
   */
  meta?: CaptureMeta;
}

/** Session metadata as stored in a fingerprint. Anything unexpected is dropped. */
function readCaptureMeta(value: unknown): CaptureMeta | null {
  if (!value || typeof value !== "object") return null;
  const meta = value as Record<string, unknown>;
  const text = (key: string): string | null =>
    typeof meta[key] === "string" && (meta[key] as string).length > 0 ? (meta[key] as string) : null;
  const num = (key: string): number | null =>
    typeof meta[key] === "number" && Number.isFinite(meta[key] as number)
      ? (meta[key] as number)
      : null;
  const source = text("source");
  const conversationId = text("conversationId");
  const device = text("device");
  const startedAt = text("startedAt");
  const updatedAt = text("updatedAt");
  const sourcePath = text("sourcePath");
  const hash = text("hash");
  const turnCount = num("turnCount");
  if (
    !source ||
    !conversationId ||
    !device ||
    !startedAt ||
    !updatedAt ||
    !sourcePath ||
    !hash ||
    turnCount === null
  ) {
    return null;
  }
  return {
    source: source as CaptureMeta["source"],
    conversationId,
    device,
    startedAt,
    updatedAt,
    sourcePath,
    turnCount,
    hash,
    includeSubagents: meta.includeSubagents === true,
    keepToolCalls: meta.keepToolCalls === true,
    redact: meta.redact !== false,
  };
}

/**
 * Reads back the fingerprints written by {@link YouBrainDaemon#rememberCaptureFiles}.
 * Unreadable or malformed data yields an empty map, which only costs one full scan.
 */
function readCaptureFiles(raw: string | null): Map<string, CaptureFileCursor> {
  const files = new Map<string, CaptureFileCursor>();
  if (!raw) return files;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return files;
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [path, value] = entry as [unknown, unknown];
      if (typeof path !== "string" || path.length === 0) continue;
      if (!value || typeof value !== "object") continue;
      const cursor = value as {
        stamp?: unknown;
        key?: unknown;
        generation?: unknown;
        meta?: unknown;
      };
      if (typeof cursor.stamp !== "string" || typeof cursor.generation !== "string") continue;
      if (cursor.key !== null && typeof cursor.key !== "string") continue;
      const meta = readCaptureMeta(cursor.meta);
      files.set(path, {
        stamp: cursor.stamp,
        key: cursor.key as string | null,
        generation: cursor.generation,
        ...(meta ? { meta } : {}),
      });
    }
  } catch {
    return new Map();
  }
  return files;
}

class LazyEmbedder implements Embedder {
  readonly model = E5_SMALL.model;
  readonly revision = E5_SMALL.revision;
  readonly dimensions = E5_SMALL.dimensions;
  #inner: Embedder | null = null;
  #close: (() => Promise<void>) | null = null;
  #loading: Promise<Embedder> | null = null;
  #closed = false;

  constructor(private readonly cacheDir: string) {}

  embedQuery(text: string): Promise<number[]> {
    return this.#load().then((inner) => inner.embedQuery(text));
  }

  embedPassages(texts: string[]): Promise<number[][]> {
    return this.#load().then((inner) => inner.embedPassages(texts));
  }

  async close(): Promise<void> {
    this.#closed = true;
    try {
      await this.#loading;
    } catch {
      // A failed load has nothing to stop.
    }
    await this.#close?.();
  }

  #load(): Promise<Embedder> {
    if (this.#closed) return Promise.reject(new Error("embed worker is closed"));
    if (this.#inner) return Promise.resolve(this.#inner);
    this.#loading ??= this.#open().then((inner) => {
      this.#inner = inner;
      return inner;
    });
    return this.#loading;
  }

  async #open(): Promise<Embedder> {
    const inner = new ProcessEmbedder({
      model: this.model,
      revision: this.revision,
      dimensions: this.dimensions,
      cacheDir: this.cacheDir,
      command: embedWorkerCommand(),
    });
    this.#close = () => inner.close();
    if (this.#closed) await inner.close();
    return inner;
  }
}

/** Semantic off never constructs an embedder, including an injected one. */
export function resolveDaemonEmbedder(options: {
  semantic: boolean;
  injected?: Embedder;
  openDefault: () => Embedder;
}): Embedder | null {
  if (!options.semantic) return null;
  return options.injected ?? options.openDefault();
}

export async function startDaemon(options: DaemonOptions = {}): Promise<YouBrainDaemon> {
  if (process.env.YOU_BRAIN_CAPTURE_WORKER === "1") {
    const { runCaptureWorker } = await import("./capture-scan.js");
    await runCaptureWorker();
    process.exit(0);
  }
  const daemon = new YouBrainDaemon(options);
  try {
    await daemon.start();
  } catch (error) {
    await daemon.stop();
    throw error;
  }
  return daemon;
}

/**
 * Background Drive push for one config file. Pushes run one at a time. A value that
 * arrives during a push replaces the one still waiting, so only the newest is sent.
 * A failed value stays waiting until `retry()`.
 */
class ConfigPush<T> {
  #waiting: { value: T } | null = null;
  #running: Promise<void> | null = null;

  constructor(
    private readonly send: (value: T) => Promise<void>,
    private readonly outcome: (failure: { error: unknown } | null) => void,
  ) {}

  submit(value: T): void {
    this.#waiting = { value };
    this.retry();
  }

  /** Starts a push only when a value is waiting and none is running. */
  retry(): void {
    if (!this.#waiting || this.#running) return;
    this.#running = this.#drain().finally(() => {
      this.#running = null;
    });
  }

  settled(): Promise<void> {
    return this.#running ?? Promise.resolve();
  }

  async #drain(): Promise<void> {
    for (let job = this.#waiting; job; job = this.#waiting) {
      try {
        await this.send(job.value);
      } catch (error) {
        this.outcome({ error });
        return;
      }
      // A newer value may have arrived during the push. Keep it for the next loop turn.
      if (this.#waiting === job) this.#waiting = null;
      this.outcome(null);
    }
  }
}

export class YouBrainDaemon {
  readonly changes = new ChangeHub();
  readonly closed: Promise<void>;
  port = 0;
  token = "";
  baseUrl = "";

  readonly #options: DaemonOptions;
  readonly #clock: DaemonClock;
  readonly #homeDir: string;
  readonly #platform: "darwin" | "linux";
  readonly #env: NodeJS.ProcessEnv;
  readonly #appVersion: string;
  readonly #watchEnabled: boolean;
  #local!: LocalConfig;
  #paths!: YouBrainPaths;
  #configFile = "";
  /** 无界面服务器上钥匙串不可用，改用文件后端。 */
  #secretBackend: SecretBackend = {};
  #shared: SharedConfig = createDefaultSharedConfig();
  #roles: Roles = createDefaultRoles();
  #zone: ZoneSettings = {
    timeZone: createDefaultRoles().timezone,
    activeLimit: createDefaultSharedConfig().topics.activeLimit,
    historyDays: createDefaultSharedConfig().topics.historyDays,
  };
  #store: SqliteStore | null = null;
  #drive: DrivePort | null = null;
  #driveReachable = false;
  #sync: ProtocolSync | null = null;
  #log: EventLog | null = null;
  #search: SearchService | null = null;
  #searchDb: Database | null = null;
  #searchSemantic: boolean | null = null;
  #embedderClose: (() => Promise<void>) | null = null;
  #notion: NotionService | null = null;
  #uploader: UploadService | null = null;
  #portrait: PortraitService | null = null;
  #coding: CodingInjection | null = null;
  #output: OutputService | null = null;
  #llm: LlmBackend | null = null;
  #llmWarning: LlmSetupWarning | null = null;
  #llmOverride: LlmBackend | null | undefined;
  /** Consecutive timeouts that produced no stdout and no stderr. */
  #cliSilentStreak = 0;
  /** How many stalls so far. Drives the backoff, so a long outage keeps backing off. */
  #cliStalls = 0;
  /**
   * A silent CLI pauses refine until this moment instead of disabling it forever.
   * Two silent timeouts usually mean the CLI is signed out or the network dropped,
   * and both can be fixed while the process keeps running.
   */
  #cliPausedUntilMs = 0;
  #retry: LlmRetryQueue<string>;

  /** True while a stalled CLI is being waited out. */
  #cliPaused(): boolean {
    return this.#clock.nowMs() < this.#cliPausedUntilMs;
  }
  #http: DaemonHttpServer | null = null;
  #lockRelease: (() => Promise<void>) | null = null;
  #live = new Map<string, LiveSession>();
  #files = new Map<string, CaptureFileCursor>();
  #watchers: FSWatcher[] = [];
  #watchTimer: ReturnType<typeof setTimeout> | null = null;
  #timer: { cancel(): void } | null = null;
  #chain: Promise<void> = Promise.resolve();
  #stopped = false;
  #abort = new AbortController();
  #started = false;
  /** False until Drive open/register has finished. Status reports reachable `null`. */
  #driveKnown = false;
  /** Set while an interactive Google login waits for the browser. Only one runs at a time. */
  #loginFlow: Promise<string> | null = null;
  /** 无界面登录时拿到的授权链接，等 #googleLogin 返回时一并交给界面。 */
  #pendingAuthorization: { url: string; tunnel: string | null } | undefined;
  /** Set once a switch has signed out. Stop then moves the state database aside. */
  #resetStateOnStop = false;
  /** False until LLM setup has finished. Status omits the setup warning. */
  #llmKnown = false;
  /** Drive and model setup. Stop does not wait on this past {@link BACKGROUND_STOP_MS}. */
  #online: Promise<void> = Promise.resolve();
  /** `#online` plus the first scan. `settled()` waits for this. */
  #services: Promise<void> = Promise.resolve();
  #stopPromise: Promise<void> | null = null;
  #resolveClosed: () => void = () => undefined;
  #onSignal: (() => void) | null = null;
  #lastFullScan: number | null = null;
  #lastFlush: number | null = null;
  #lastHeartbeat: number | null = null;
  #lastPull: number | null = null;
  #lastPortrait: number | null = null;
  #lastSearch: number | null = null;
  #lastVector: number | null = null;
  #lastNotionSync: number | null = null;
  #lastReminders: number | null = null;
  #lastConsolidation: number | null = null;
  #lastWebSessions: number | null = null;
  #lastRefineBackfill: number | null = null;
  /** Sessions uploaded after this process started are the live path's job, not the backfill's. */
  #bootedAtMs: number | null = null;
  #lastWebhook: number | null = null;
  #webhook: WebhookConfig = defaultWebhookConfig();
  #webhookFetch: WebhookFetch = fetch;
  #webhookTimer: { cancel(): void } | null = null;
  /** Serializes delivery and config writes. Independent of the daemon tick chain. */
  #webhookChain: Promise<void> = Promise.resolve();
  #consolidationState: ConsolidationState = emptyConsolidationState();
  /** Latest keyboard, pointer, or captured-session time. Not the heartbeat clock. */
  #lastActivityAt: string | null = null;
  /** Device-table activity from before this process wrote a row. */
  #preservedActivityAt: string | null = null;
  #preservedLoaded = false;
  #lastSyncAt: string | null = null;
  #lastSyncError: { message: string; at: string } | null = null;
  /** Config push failures per file. A success clears `#lastSyncError` only when it is this push's error. */
  #configPushErrors: Record<"shared" | "roles", { message: string; at: string } | null> = {
    shared: null,
    roles: null,
  };
  #sharedPush = new ConfigPush<SharedConfig>(
    async (config) => {
      await this.#sync?.updateShared(config);
    },
    (failure) => this.#onConfigPush("shared", failure),
  );
  #rolesPush = new ConfigPush<Roles>(
    async (roles) => {
      await this.#sync?.updateRoles(roles);
    },
    (failure) => this.#onConfigPush("roles", failure),
  );
  /** The search index still has documents to index. Cleared only when a text pass finishes. */
  #searchTextDirty = false;
  /** Vector backfill filled holes on the last pass, so the next tick continues it. */
  #vectorDirty = false;
  /** `inbox.pending` still has files to index. Cleared only when that queue is empty. */
  #inboxDirty = false;
  #portraitSoon = false;
  /** Topic book changed while this device is allowed to publish topic files. */
  #topicFilesDirty = false;
  /** Epoch bumps on each change so an in-flight sync does not clear a newer edit. */
  #topicFilesEpoch = 0;
  #topicFilesQuietUntil: number | null = null;
  #topicFilesLock: Promise<void> = Promise.resolve();
  #scannedOnce = false;
  /**
   * Refine is the only tick work that waits on a model, and a model call can run for
   * minutes. It runs detached so the serial tick keeps uploading, pulling, and scanning
   * meanwhile. Both passes are idempotent and guard their own writes.
   */
  #webJob: Promise<void> | null = null;
  #backfillJob: Promise<void> | null = null;
  /**
   * Uploading runs on its own loop, not inside the tick.
   *
   * Each upload is a handful of Drive round trips, so a tick that could only afford a
   * few of them left a 2,800 session backlog crawling: the queue was throttled by the
   * tick period rather than by Drive. The loop keeps going while sessions are due and
   * stops as soon as none are left, which is what the idle gate does for a live session.
   */
  #uploadJob: Promise<void> | null = null;
  /**
   * Set while the tick is pulling, flushing, or indexing from Drive. The upload loop
   * waits for these windows, so a long upload backlog cannot delay the change feed.
   */
  #syncBusy = false;
  /**
   * Where the next upload pass starts. Without it every pass began at the first entry,
   * so one slow session could spend the whole budget and the rest never ran.
   */
  #uploadCursor = 0;
  #uploadSlowestMs = 0;
  #uploadFailures = 0;
  #uploadLastError: string | null = null;
  /** Files the last scan had to parse, for the status view and the fingerprint tests. */
  #lastScanParsed = 0;

  constructor(options: DaemonOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemDaemonClock();
    this.#homeDir = options.homeDir ?? homedir();
    this.#env = options.env ?? process.env;
    this.#appVersion = options.appVersion ?? APP_VERSION;
    this.#watchEnabled = options.watch !== false;
    this.#webhookFetch = options.webhookFetch ?? fetch;
    this.#llmOverride = options.llm;
    const platform = options.platform ?? process.platform;
    assertSupportedPlatform(platform);
    if (platform !== "darwin" && platform !== "linux") {
      throw new YouBrainError("PLATFORM_UNSUPPORTED", "you-brain supports macOS and Linux");
    }
    this.#platform = platform;
    this.#zone.now = () => this.#clock.now();
    this.#retry = new LlmRetryQueue<string>({ clock: { now: () => this.#clock.nowMs() } });
    this.closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  async start(): Promise<void> {
    const log = createStartupLog();
    const loaded = await log.time("loadLocalConfig", () =>
      loadLocalConfig({
        homeDir: this.#homeDir,
        platform: this.#platform,
        env: this.#env,
        ...(this.#options.hostname ? { hostname: this.#options.hostname } : {}),
        ...(this.#options.role ? { role: this.#options.role } : {}),
      }),
    );
    this.#local = loaded.config;
    this.#paths = loaded.paths;
    this.#configFile = loaded.configFile;
    this.#secretBackend = resolveSecretBackend({
      env: this.#env,
      dataDir: this.#paths.dataDir,
      role: this.#local.role,
    });
    const lock = await log.time("acquireDaemonLock", () => acquireDaemonLock(this.#paths.lockFile));
    this.#lockRelease = lock.release;
    this.#shared = await log.time("readShared", () =>
      readSharedFile(join(this.#paths.dataDir, "shared.json"), createDefaultSharedConfig()),
    );
    this.#roles = await log.time("readRoles", () =>
      readRolesFile(join(this.#paths.dataDir, "roles.json"), createDefaultRoles()),
    );
    this.#applyZone();
    this.#store = await log.time("openStore", () => new SqliteStore(this.#paths.stateFile));
    this.#log = new EventLog(this.#store, this.#local.deviceId, {
      now: () => this.#clock.now(),
    });
    this.#files = readCaptureFiles(this.#store.getCursor(CAPTURE_FILES_CURSOR));
    this.#restoreLiveFromFiles();
    this.#webhook = await log.time("readWebhook", () =>
      readWebhookConfig(webhookConfigPath(this.#paths.dataDir)),
    );
    this.#armWebhookWindow();
    const consent = new FilePortraitConsentStore(portraitConsentPath(this.#paths.dataDir));
    const managedStatePath = join(this.#paths.dataDir, "managed-blocks.json");
    this.#coding = new CodingInjection({
      homeDir: this.#homeDir,
      managedStatePath,
      consent,
      codingPath: () => this.#codingVariantPath(),
    });
    if (this.#llmOverride !== undefined) {
      this.#llm = this.#llmOverride;
      this.#llmKnown = true;
    }
    await log.time("mountOutput", () => {
      this.#mountOutput();
    });
    this.#rememberDevice();
    const http = await log.time("http", () =>
      startDaemonHttp({
        dataDir: this.#paths.dataDir,
        deps: this.#deps(),
        hub: this.changes,
        ...(this.#options.port !== undefined ? { port: this.#options.port } : {}),
        ...(this.#options.staticDir ? { staticDir: this.#options.staticDir } : {}),
      }),
    );
    this.#http = http;
    this.port = http.port;
    this.token = http.token;
    this.baseUrl = http.baseUrl;
    const startedAt = this.#clock.nowMs();
    this.#lastFullScan = startedAt;
    this.#lastFlush = startedAt;
    this.#lastHeartbeat = startedAt;
    this.#lastPull = startedAt;
    this.#lastWebSessions = startedAt;
    this.#lastRefineBackfill = startedAt;
    this.#bootedAtMs = startedAt;
    this.#lastPortrait = startedAt;
    this.#lastSearch = startedAt;
    this.#lastVector = startedAt;
    this.#started = true;
    try {
      await this.#issueReminders();
    } catch {
      // A reminder failure must not block startup.
    }
    this.#lastReminders = this.#clock.nowMs();
    if (this.#options.signals === true) {
      this.#onSignal = () => {
        void this.stop();
      };
      process.on("SIGINT", this.#onSignal);
      process.on("SIGTERM", this.#onSignal);
    }
    this.#online = this.#openServices(log, consent, managedStatePath);
    this.#services = this.#online.then(async () => {
      if (this.#stopped) return;
      this.#arm();
      if (this.#stopped) return;
      await log.time("scan", () => this.scan().catch(() => undefined));
    });
  }

  /**
   * Drive, search, model probe, watchers, and coding injection.
   * Failures are logged and do not stop the HTTP server.
   */
  async #openServices(
    log: StartupLog,
    consent: FilePortraitConsentStore,
    managedStatePath: string,
  ): Promise<void> {
    try {
      if (this.#stopped) return;
      await log.time("openDrive", () => this.#openDrive());
      if (this.#stopped) return;
      if (this.#drive && this.#store) {
        await this.#connectDrive(log, consent, managedStatePath);
      } else {
        this.#driveReachable = false;
      }
    } catch (error) {
      this.#driveReachable = false;
      const message = error instanceof Error ? error.message : "failed";
      console.error(`startup: background ${message}`);
    } finally {
      this.#driveKnown = true;
      // Pages loaded during startup hold the "unknown" Drive state until told otherwise.
      this.changes.publish("status", this.#clock.now().toISOString());
    }
    if (this.#stopped) return;
    if (!this.#llmKnown) {
      try {
        this.#llm = await log.time("createLlm", () => this.#createLlm());
      } catch {
        this.#llm = null;
      }
      this.#llmKnown = true;
    }
    if (this.#stopped) return;
    try {
      await log.time("rewatch", () => this.#rewatch());
    } catch {
      // A missing source directory is skipped inside #rewatch.
    }
    if (this.#stopped) return;
    await log.time("ensureCoding", () => this.#ensureCoding());
    // Model warnings and the search index settle after Drive, so status changes again here.
    this.changes.publish("status", this.#clock.now().toISOString());
    // 知识库挂载是纯内存工作;钥匙串探测和首次同步留给后台 tick,
    // 启动路径既不等待网络也不等待 security CLI。
    if (this.#paths) {
      try {
        await log.time("mountNotion", () => this.#mountNotion());
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed";
        console.error(`startup: notion ${message}`);
      }
    }
  }

  async #mountNotion(): Promise<void> {
    if (!this.#paths) return;
    this.#notion ??= new NotionService({
      dataDir: this.#paths.dataDir,
      platform: this.#platform,
      backend: this.#secretBackend,
    });
  }

  #requireNotion(): NotionService {
    if (!this.#notion) {
      throw new HttpError(503, "NOTION_UNAVAILABLE", "知识库服务未就绪");
    }
    return this.#notion;
  }

  /**
   * Starts the Drive-backed services. Startup calls it after openDrive. A successful
   * interactive Google login calls it too, so Drive comes up without a restart.
   */
  async #connectDrive(
    log: StartupLog,
    consent: FilePortraitConsentStore,
    managedStatePath: string,
  ): Promise<void> {
    const drive = this.#drive;
    const store = this.#store;
    if (!drive || !store) return;
    this.#sync = new ProtocolSync({
      drive,
      store,
      device: this.#identity(),
      listener: {
        onTopicsChanged: () => {
          this.#onTopicsChanged();
        },
        onInboxChanged: (files) => {
          this.#enqueueInbox(files);
        },
        onDigitalTwinChanged: () => {
          this.#portraitSoon = true;
        },
        onConfigChanged: (update) => this.#onConfigChanged(update),
      },
      now: () => this.#clock.now(),
    });
    if (readInboxPending(store).length > 0) this.#inboxDirty = true;
    this.#uploader = new UploadService({
      drive,
      index: this.#uploadIndex(),
      deviceId: this.#local.deviceId,
      clock: { now: () => this.#clock.nowMs() },
    });
    this.#portrait = new PortraitService({
      drive,
      store,
      paths: this.#paths,
      config: {
        variants: this.#shared.portrait.variants,
        snapshotPattern: this.#shared.portrait.snapshotPattern,
      },
      driveRoot: this.#local.driveRoot,
      consent,
      homeDir: this.#homeDir,
      managedStatePath,
    });
    const sync = this.#sync;
    if (!sync) {
      this.#driveReachable = false;
    } else {
      try {
        await log.time("syncRegister", () =>
          sync.register({ lastActiveAt: this.#activityForDevice() }),
        );
        if (!this.#stopped) this.#driveReachable = true;
      } catch {
        this.#driveReachable = false;
      }
      if (!this.#stopped) this.#rememberDevice();
    }
    if (!this.#stopped) {
      try {
        await log.time("mountSearch", () => this.#mountSearch());
      } catch {
        this.#search = null;
      }
    }
  }

  scan(extra?: { includeSubagents?: boolean }): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    return this.#run(async () => {
      await this.#scanBody(extra);
    });
  }

  async settled(): Promise<void> {
    await this.#services;
    await this.#chain;
    // A detached refine pass belongs to "settled" too: tests and shutdown both want to
    // know that nothing is still writing. A pass can be started by the tick it overlaps,
    // so keep draining until none is left.
    for (let round = 0; round < 8; round += 1) {
      const jobs = [this.#webJob, this.#backfillJob, this.#uploadJob].filter(
        (job): job is Promise<void> => job !== null,
      );
      if (jobs.length === 0) break;
      await Promise.all(jobs);
      await this.#chain;
    }
    await this.#output?.whenIdle();
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stopBody();
    return this.#stopPromise;
  }

  async #stopBody(): Promise<void> {
    this.#stopped = true;
    this.#abort.abort();
    this.#webhookTimer?.cancel();
    this.#webhookTimer = null;
    await this.#webhookChain.catch(() => undefined);
    await Promise.race([
      this.#online.catch(() => undefined),
      delay(BACKGROUND_STOP_MS),
    ]);
    this.#timer?.cancel();
    this.#timer = null;
    if (this.#watchTimer) {
      clearTimeout(this.#watchTimer);
      this.#watchTimer = null;
    }
    if (this.#onSignal) {
      process.off("SIGINT", this.#onSignal);
      process.off("SIGTERM", this.#onSignal);
      this.#onSignal = null;
    }
    // A config value saved locally but not yet on Drive gets one last push before exit.
    this.#retryConfigPush();
    await Promise.race([this.settleConfigPush(), delay(FLUSH_DEADLINE_MS)]);
    try {
      await this.#run(async () => {
        this.#closeWatchers();
        if (this.#sync) {
          // A stuck Drive call must not keep the process up. The outbox retries next start.
          await Promise.race([
            this.#sync.flush().catch(() => undefined),
            delay(FLUSH_DEADLINE_MS),
          ]);
        }
        try {
          await this.#output?.flush();
        } catch {
          // Local markdown is derived and can be rebuilt.
        }
        this.#output?.close();
        this.#output = null;
        if (this.#embedderClose) {
          await this.#embedderClose().catch(() => undefined);
          this.#embedderClose = null;
        }
        this.#searchDb?.close();
        this.#searchDb = null;
        this.#search = null;
        this.#searchSemantic = null;
        this.#notion?.close();
        this.#notion = null;
        this.#store?.close();
        this.#store = null;
        if (this.#resetStateOnStop && this.#paths) {
          try {
            await moveStateAside({
              dataDir: this.#paths.dataDir,
              stateFile: this.#paths.stateFile,
              now: this.#clock.now(),
            });
          } catch (error) {
            console.error(`switch: backup ${error instanceof Error ? error.message : "failed"}`);
          }
        }
        await this.#http?.stop();
        this.#http = null;
      }, "shutdown");
    } finally {
      this.#closeWatchers();
      if (this.#http) {
        await this.#http.stop().catch(() => undefined);
        this.#http = null;
      }
      if (this.#lockRelease) {
        await this.#lockRelease().catch(() => undefined);
        this.#lockRelease = null;
      }
      this.#resolveClosed();
    }
  }

  #arm(): void {
    if (this.#stopped) return;
    this.#timer?.cancel();
    this.#timer = this.#clock.schedule(INTERVALS.tickMs, () => this.#tick());
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.#run(async () => {
        if (this.#stopped) return;
        await this.#runDue();
      });
    } catch {
      // One bad tick must not stop the loop.
    }
    if (!this.#stopped) this.#arm();
  }

  /**
   * Runs the Drive-facing tick steps while the upload loop stands down, so a large
   * upload backlog cannot delay the change feed or the outbox flush.
   */
  async #withSyncWindow(run: () => Promise<void>): Promise<void> {
    this.#syncBusy = true;
    try {
      await run();
    } finally {
      this.#syncBusy = false;
    }
  }

  /** Text sync runs on the interval, or right away while documents are still queued. */
  #searchTextDue(now: number): boolean {
    return this.#searchTextDirty || intervalDue(this.#lastSearch, now, INTERVALS.searchMs);
  }

  /**
   * Backfill runs on its own clock: once per interval, or again on the next tick while the
   * last pass made progress. It must not pull the change feed, which is what text sync does.
   */
  #vectorDue(now: number): boolean {
    return this.#vectorDirty || intervalDue(this.#lastVector, now, INTERVALS.searchMs);
  }

  async #runDue(): Promise<void> {
    if (this.#stopped) return;
    const now = this.#clock.nowMs();
    if (intervalDue(this.#lastFullScan, now, INTERVALS.fullScanMs)) {
      await this.#scanBody();
      this.#lastFullScan = this.#clock.nowMs();
    }
    this.#startUploadLoop();
    await this.#withSyncWindow(async () => {
      if (this.#sync && intervalDue(this.#lastFlush, now, INTERVALS.flushMs)) {
        try {
          await this.#sync.flush();
          this.#driveReachable = true;
        } catch {
          this.#driveReachable = false;
        }
        this.#lastFlush = this.#clock.nowMs();
      }
      if (intervalDue(this.#lastHeartbeat, now, INTERVALS.heartbeatMs)) {
        await this.#heartbeat();
        this.#lastHeartbeat = this.#clock.nowMs();
      }
      if (
        this.#sync &&
        intervalDue(this.#lastPull, now, pullInterval(this.changes.subscriberCount()))
      ) {
        try {
          const pulled = await this.#sync.pull();
          this.#rememberSyncSuccess();
          if (pulled.applied > 0) this.#scheduleWebhook();
        } catch (error) {
          this.#rememberSyncFailure(error);
        }
        this.#restoreLocalActivity();
        this.#lastPull = this.#clock.nowMs();
      }
      if (this.#inboxDirty) {
        try {
          await this.#drainInbox({ budgetMs: INTERVALS.inboxBudgetMs });
        } catch {
          // One bad pass must not stop the loop. The queue stays for the next tick.
        }
      }
    });
    if (intervalDue(this.#lastWebSessions, now, INTERVALS.webSessionsMs)) {
      this.#lastWebSessions = this.#clock.nowMs();
      this.#webJob ??= this.#processWebSessions()
        .catch(() => {
          // One bad pass must not stop the loop.
        })
        .finally(() => {
          this.#webJob = null;
        });
    }
    if (intervalDue(this.#lastRefineBackfill, now, INTERVALS.refineBackfillMs)) {
      this.#lastRefineBackfill = this.#clock.nowMs();
      this.#backfillJob ??= this.#refineBackfill()
        .catch(() => {
          // One bad pass must not stop the loop.
        })
        .finally(() => {
          this.#backfillJob = null;
        });
    }
    if (this.#notion) {
      if (intervalDue(this.#lastNotionSync, now, INTERVALS.notionMs)) {
        this.#lastNotionSync = this.#clock.nowMs();
        try {
          // 单轮预算收紧,别让首轮大导入把一个 tick 占满。
          if (await this.#notion.hasToken()) {
            const summary = await this.#notion.sync(15_000);
            if (summary.pagesSynced > 0 || summary.databasesSynced > 0 || summary.removed > 0) {
              this.changes.publish("notion", this.#clock.now().toISOString());
            }
          }
        } catch {
          // 限流或令牌失效都不是致命的;状态里能看到 lastError。
        }
      }
    }
    if (
      this.#portrait &&
      (this.#portraitSoon || intervalDue(this.#lastPortrait, now, INTERVALS.portraitMs))
    ) {
      try {
        await this.#portrait.pull();
      } catch {
        // A missing twin file is not fatal.
      }
      this.#portraitSoon = false;
      this.#lastPortrait = this.#clock.nowMs();
    }
    if (this.#search) {
      if (this.#searchTextDue(now)) {
        try {
          const result = await this.#search.sync({ budgetMs: 20_000, embed: false });
          // Unfinished text sync stays dirty so the next tick continues it.
          this.#searchTextDirty = !result.done;
          // Freshly indexed chunks have no vectors yet. Fill them before the next interval.
          if (result.done) this.#vectorDirty = true;
        } catch {
          // Keyword search keeps the last successful index.
          this.#searchTextDirty = false;
        }
        this.#lastSearch = this.#clock.nowMs();
      }
      // Text sync comes first: vectors for a document that is not indexed yet are wasted work.
      if (!this.#searchTextDirty && this.#vectorDue(now)) {
        try {
          const filled = await this.#search.backfillVectors({ budgetMs: 10_000 });
          // One tick embeds at most once. Progress with holes continues next tick;
          // no progress means a missing model or a spent retry window, so wait for the interval.
          this.#vectorDirty = filled.remaining > 0 && filled.embedded > 0;
        } catch {
          // A failed backfill must not stop the loop. The next interval retries.
          this.#vectorDirty = false;
        }
        this.#lastVector = this.#clock.nowMs();
      }
    }
    if (intervalDue(this.#lastReminders, now, INTERVALS.reminderMs)) {
      try {
        await this.#issueReminders();
      } catch {
        // Keep the loop alive. The next interval tries again.
      }
      this.#lastReminders = this.#clock.nowMs();
    }
    if (intervalDue(this.#lastConsolidation, now, INTERVALS.consolidationMs)) {
      try {
        await this.#consolidate({ manual: false, force: false });
      } catch {
        // A bad lease or model call must not stop the loop.
      }
      this.#lastConsolidation = this.#clock.nowMs();
    }
    if (
      this.#topicFilesDirty &&
      this.#topicFilesQuietUntil !== null &&
      now >= this.#topicFilesQuietUntil
    ) {
      if (this.#canWriteTopicFiles()) {
        try {
          await this.#writeTopicFiles();
        } catch {
          this.#topicFilesDirty = true;
          this.#topicFilesQuietUntil = this.#clock.nowMs() + INTERVALS.topicFilesDebounceMs;
        }
      }
    }
    if (!this.#stopped && intervalDue(this.#lastWebhook, now, INTERVALS.webhookMs)) {
      try {
        await this.#runWebhook();
      } catch {
        // One bad delivery must not stop the loop.
      }
      this.#lastWebhook = this.#clock.nowMs();
    }
  }

  /** Starts the upload loop when anything is queued and it is not already running. */
  #startUploadLoop(): void {
    if (this.#uploadJob || this.#stopped) return;
    let queued = false;
    for (const live of this.#live.values()) {
      if (live.schedule.dirtySince !== null) {
        queued = true;
        break;
      }
    }
    if (!queued) return;
    this.#uploadJob = this.#uploadLoop()
      .catch(() => {
        // One bad pass must not stop the loop; the next tick starts a new one.
      })
      .finally(() => {
        this.#uploadJob = null;
      });
  }

  /**
   * Uploads until nothing is due. A session that is still active stays queued and is
   * picked up by a later tick, which is the idle gate working as intended.
   */
  async #uploadLoop(): Promise<void> {
    for (;;) {
      if (this.#stopped) return;
      // Give the change feed and the outbox flush a clear window first.
      while (this.#syncBusy && !this.#stopped) await delay(INTERVALS.uploadLoopGapMs);
      if (this.#stopped) return;
      const result = await this.#processDue({ budgetMs: INTERVALS.uploadBudgetMs });
      if (this.#stopped) return;
      // Nothing moved: every remaining session is waiting for its idle window, or the
      // writes failed and the next tick should try again.
      if (result.uploaded === 0) return;
      // Yield between batches. Uploading without a pause fills the Drive connection pool
      // and the pull and flush in the tick starve behind it.
      await delay(INTERVALS.uploadLoopGapMs);
    }
  }

  async #processDue(options?: {
    forceIdle?: boolean;
    sources?: readonly string[];
    /** Stop starting new sessions after this long. The rest stay due for the next tick. */
    budgetMs?: number;
  }): Promise<{ scanned: number; uploaded: number }> {
    const now = this.#clock.nowMs();
    const backfill =
      options?.forceIdle === true || this.#store?.getCursor(BACKFILL_CURSOR) === "pending";
    const idleMs = backfill ? 0 : this.#shared.refine.idleMinutes * 60_000;
    const activeIntervalMs = DEFAULT_UPLOAD_ACTIVE_INTERVAL_MINUTES * 60_000;
    let uploaded = 0;
    const sessions = [...this.#live.entries()].filter(([, live]) =>
      options?.sources ? options.sources.includes(live.source) : true,
    );
    // Rotate the starting point so a slow or failing session cannot starve the rest
    // when the budget runs out mid-pass.
    const total = sessions.length;
    const start = total === 0 ? 0 : this.#uploadCursor % total;
    for (let offset = 0; offset < total; offset += 1) {
      const entry = sessions[(start + offset) % total];
      if (!entry) continue;
      const [key, live] = entry;
      if (this.#stopped) return { scanned: total, uploaded };
      if (options?.budgetMs !== undefined && this.#clock.nowMs() - now >= options.budgetMs) {
        this.#uploadCursor = (start + offset) % total;
        return { scanned: total, uploaded };
      }
      const decision = decideUpload(live.schedule, now, { idleMs, activeIntervalMs });
      if (!decision.due) {
        if (this.#isIdle(live, now, idleMs)) await this.#retryIfDue(key, live, now);
        continue;
      }
      const startedAt = this.#clock.nowMs();
      try {
        const did = await this.#uploadOne(key, live);
        if (did) uploaded += 1;
        this.#uploadFailures = 0;
        this.#uploadLastError = null;
        this.#uploadSlowestMs = Math.max(this.#uploadSlowestMs, this.#clock.nowMs() - startedAt);
      } catch (error) {
        // Leave the session dirty so the next tick retries the upload, but say so:
        // a pass that keeps failing otherwise looks like an idle daemon.
        this.#uploadFailures += 1;
        this.#uploadLastError = error instanceof Error ? error.message : String(error);
      }
    }
    this.#uploadCursor = 0;
    if (this.#store?.getCursor(BACKFILL_CURSOR) === "pending" && this.#scannedOnce) {
      this.#store.setCursor(BACKFILL_CURSOR, "done");
    }
    return { scanned: sessions.length, uploaded };
  }

  async #uploadOne(key: string, live: LiveSession): Promise<boolean> {
    if (!this.#uploader) return false;
    const before = live.hash;
    const session = await this.#materialize(live);
    if (!session) return false;
    const hash = sessionHash(session);
    if (hash !== live.hash) {
      live.hash = hash;
      live.turnCount = session.turns.length;
      live.startedAt = session.startedAt;
      live.updatedAt = session.updatedAt;
    }
    const result = await this.#uploader.upload(this.#renderUpload(live, session));
    this.#rememberUpload(live, result.fileId, result.key);
    this.#searchTextDirty = true;
    const now = this.#clock.nowMs();
    const current = this.#live.get(key) ?? live;
    // Uploading is a sync step, nothing more: waiting for a model here made a 2,800
    // session backlog take a day and a half, because every write queued behind a
    // 30-60 second refine call. Refining runs on its own schedule (`#refineBackfill`),
    // which reads the session back from Drive.
    current.schedule = {
      lastActivityAt: current.hash === before ? current.schedule.lastActivityAt : now,
      lastUploadAt: now,
      dirtySince: null,
    };
    return true;
  }

  async #refine(
    key: string,
    live: LiveSession,
    fileId: string,
    known?: NormalizedSession,
  ): Promise<void> {
    if (!this.#llm || !this.#store || fileId.length === 0) return;
    const session = known ?? (await this.#materialize(live));
    if (!session) return;
    await this.#runRefine({
      key,
      source: live.source,
      fileId,
      turns: session.turns.map((turn) => ({ role: turn.role, text: turn.text })),
    });
  }

  /** Model call, copied events, and the shared retry / CLI-stall guard. */
  async #runRefine(input: {
    key: string;
    source: string;
    fileId: string;
    turns: readonly { role: string; text: string }[];
  }): Promise<void> {
    if (!this.#llm || !this.#store || input.fileId.length === 0) return;
    const stored = this.#store.getSession(input.key);
    const refinedUpTo = stored?.refinedUpTo ?? 0;
    const messages = input.turns.slice(refinedUpTo).map((turn) => ({
      role: turn.role,
      text: turn.text,
    }));
    if (messages.length === 0) {
      this.#retry.succeed(input.key);
      return;
    }
    if (this.#cliPaused()) return;
    try {
      const result = await refineSession(
        this.#llm,
        {
          sessionKey: input.key,
          fileId: input.fileId,
          source: input.source,
          refinedUpTo,
          messages,
          previous: this.#previous(input.key, stored),
          topics: this.#candidateTopics(),
          openTodos: this.#openTodos(),
        },
        {
          eventFactory: createRefineEventFactory({
            device: this.#local.deviceId,
            ts: () => this.#clock.now().toISOString(),
            startSeq: 1,
          }),
          ids: defaultRefineIds(this.#clock.nowMs()),
        },
      );
      if (result.status === "skipped") {
        this.#cliSilentStreak = 0;
        this.#cliStalls = 0;
        if (result.reason === "no_new_messages") this.#retry.succeed(input.key);
        else this.#retry.fail(input.key, input.key, new Error(result.detail));
        return;
      }
      for (const event of result.events) await this.#emitCopied(event);
      this.#cliSilentStreak = 0;
      this.#cliStalls = 0;
      this.#retry.succeed(input.key);
    } catch (error) {
      if (isCliNoOutputTimeout(error)) this.#cliSilentStreak += 1;
      else this.#cliSilentStreak = 0;
      if (this.#cliSilentStreak >= 2) {
        this.#cliSilentStreak = 0;
        this.#cliStalls += 1;
        const wait = Math.min(
          INTERVALS.cliStallMinMs * 2 ** (this.#cliStalls - 1),
          INTERVALS.cliStallMaxMs,
        );
        this.#cliPausedUntilMs = this.#clock.nowMs() + wait;
      }
      this.#retry.fail(input.key, input.key, error);
      this.changes.publish("status", this.#clock.now().toISOString());
    }
  }

  #canProcessWebSessions(): boolean {
    if (this.#cliPaused() || !this.#llm || !this.#drive || !this.#store) return false;
    const processor = resolveWebProcessor(this.#roles);
    return processor !== null && processor === this.#local.deviceId;
  }

  #webRetryBlocked(key: string, now: number): boolean {
    const job = this.#retry.get(key);
    if (!job) return false;
    return job.exhausted || job.nextAttemptAt > now;
  }

  async #processWebSessions(): Promise<void> {
    if (!this.#canProcessWebSessions()) return;
    const store = this.#store;
    const drive = this.#drive;
    if (!store || !drive) return;
    const now = this.#clock.nowMs();
    const pending = pendingWebSessions({
      indexed: listWebInbox(store),
      sessions: store.listSessions(),
      nowMs: now,
      idleMs: this.#shared.refine.idleMinutes * 60_000,
      blocked: (key) => this.#webRetryBlocked(key, now),
    }).slice(0, WEB_SESSION_BATCH);
    // Two refine calls at once drain a backlog twice as fast. A subscription CLI shares
    // one work directory per call, so its queue stays sequential.
    const concurrency =
      this.#llm?.descriptor.kind === "cli" ? 1 : Math.min(WEB_SESSION_CONCURRENCY, pending.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!this.#stopped && this.#canProcessWebSessions()) {
        const item = pending[next];
        if (item === undefined) return;
        next += 1;
        try {
          await this.#refineWebSession(item);
        } catch {
          // One bad session must not stop the batch.
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  /**
   * Refines this device's sessions that are on Drive but not yet refined, newest first.
   *
   * This is the only place a captured session is handed to the model. Uploading does not
   * wait for it: a library that was captured while signed out holds thousands of
   * sessions, and queueing each write behind a 30-60 second model call left the backlog
   * growing for days. Keeping the two apart lets Drive fill up fast and the topics catch
   * up afterwards.
   *
   * Only sessions updated in the last {@link REFINE_BACKFILL_WINDOW_DAYS} days are
   * refined, because that is the window the topic list shows and every call costs money.
   * Newest first means a conversation the user just finished is refined before history.
   */
  async #refineBackfill(): Promise<void> {
    const drive = this.#drive;
    const store = this.#store;
    if (!drive || !store || !this.#llm) return;
    if (this.#cliPaused()) return;
    // Both passes share one CLI slot. A web session is what the user just produced, so
    // it goes first; the history backlog only loses time, which costs nothing.
    if (countUnrefinedWebSessions(listWebInbox(store), store.listSessions()) > 0) return;
    const windowDays = this.#options.refineBackfillWindowDays ?? REFINE_BACKFILL_WINDOW_DAYS;
    const since = new Date(this.#clock.nowMs() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const pending = store
      .listSessions({ unrefinedOnly: true, updatedSince: since })
      .filter((session) => session.device === this.#local.displayName)
      .filter((session) => session.fileId !== null)
      .filter((session) => !this.#webRetryBlocked(session.sessionKey, this.#clock.nowMs()))
      .slice(0, INTERVALS.refineBackfillBatch);
    for (const session of pending) {
      if (this.#stopped || !this.#llm) return;
      try {
        await this.#refineStoredSession(session);
      } catch (error) {
        this.#retry.fail(session.sessionKey, session.sessionKey, error);
      }
    }
  }

  /** One stored session: read its markdown from Drive and run the refine step. */
  async #refineStoredSession(session: {
    sessionKey: string;
    source: string;
    fileId: string | null;
    msgCount: number;
  }): Promise<void> {
    const drive = this.#drive;
    const store = this.#store;
    if (!drive || !store || session.fileId === null) return;
    const object = await drive.read(session.fileId);
    const parsed = parseWebSession(object.bytes.toString("utf8"));
    if (!parsed) {
      this.#retry.fail(
        session.sessionKey,
        session.sessionKey,
        new LlmRequestError("client", "会话原文无法解析"),
      );
      return;
    }
    await this.#runRefine({
      key: session.sessionKey,
      source: session.source,
      fileId: session.fileId,
      turns: parsed.turns,
    });
  }

  async #refineWebSession(item: { sessionKey: string; fileId: string }): Promise<void> {
    const drive = this.#drive;
    const store = this.#store;
    if (!drive || !store) return;
    let markdown: string;
    try {
      const object = await drive.read(item.fileId);
      markdown = object.bytes.toString("utf8");
    } catch (error) {
      this.#retry.fail(item.sessionKey, item.sessionKey, error);
      this.changes.publish("status", this.#clock.now().toISOString());
      return;
    }
    const parsed = parseWebSession(markdown);
    if (!parsed) {
      this.#retry.fail(
        item.sessionKey,
        item.sessionKey,
        new LlmRequestError("client", "网页会话无法解析"),
      );
      this.changes.publish("status", this.#clock.now().toISOString());
      return;
    }
    const stored = store.getSession(item.sessionKey);
    const refinedUpTo = stored?.refinedUpTo ?? 0;
    if (parsed.turns.length <= refinedUpTo) {
      this.#retry.succeed(item.sessionKey);
      store.upsertSession({
        sessionKey: item.sessionKey,
        source: parsed.source,
        device: parsed.device || stored?.device || this.#local.displayName,
        startedAt: parsed.startedAt,
        updatedAt: parsed.updatedAt,
        fileId: item.fileId,
        msgCount: parsed.turns.length,
      });
      return;
    }
    await this.#runRefine({
      key: item.sessionKey,
      source: parsed.source,
      fileId: item.fileId,
      turns: parsed.turns,
    });
  }

  async #retryIfDue(key: string, live: LiveSession, now: number): Promise<void> {
    if (this.#cliPaused()) return;
    const job = this.#retry.get(key);
    if (!job || job.exhausted || job.nextAttemptAt > now || !this.#llm || !this.#store) return;
    const fileId = this.#store.getSession(key)?.fileId;
    if (!fileId) return;
    await this.#refine(key, live, fileId);
  }

  async #scanBody(extra?: { includeSubagents?: boolean }): Promise<void> {
    if (this.#stopped || this.#abort.signal.aborted) {
      this.#scannedOnce = true;
      return;
    }
    const roots = this.#roots();
    const sources = SESSION_SOURCES.filter((id) => roots[id].length > 0);
    if (sources.length === 0) {
      this.#scannedOnce = true;
      return;
    }
    const capture = this.#shared.capture;
    const includeSubagents = extra?.includeSubagents ?? capture.includeSubagents;
    const keepToolCalls = capture.keepToolCalls;
    const redact = capture.redact;
    const generation = captureGeneration({ includeSubagents, keepToolCalls, redact });
    const request: CaptureScanRequest = {
      device: this.#local.displayName,
      includeSubagents,
      keepToolCalls,
      redact,
      generation,
      sources,
      sourceFilters: captureSourceFilters(capture.sources),
      paths: {
        claude: roots["claude-code"],
        codex: roots.codex,
        grok: roots["grok-build"],
        cursor: roots.cursor,
        gemini: roots["gemini-cli"],
        pi: roots.pi,
        t3: roots["t3-code"],
        zcode: roots.zcode,
      },
      cursors: this.#captureCursors(),
    };
    let hits: CaptureHit[];
    try {
      hits = captureWorkerBinary()
        ? await this.#scanInWorker(request)
        : await collectCaptureHits(request, this.#abort.signal);
    } catch (error) {
      if (this.#stopped || this.#abort.signal.aborted) {
        this.#scannedOnce = true;
        return;
      }
      throw error;
    }
    if (this.#stopped || this.#abort.signal.aborted) {
      this.#scannedOnce = true;
      return;
    }
    const snapshots = new Map<string, CaptureMeta>();
    for (const hit of hits) {
      if (!hit.unchanged || !hit.key) continue;
      const existing = this.#live.get(hit.key);
      if (existing && existing.sourcePath === hit.path) snapshots.set(hit.path, metaFrom(existing));
    }
    const seen = new Set<string>();
    const now = this.#clock.nowMs();
    const ordered = hits
      .map((hit) => {
        const meta = hit.meta ?? snapshots.get(hit.path) ?? null;
        return meta && hit.key ? { ...hit, key: hit.key, meta } : null;
      })
      .filter((hit): hit is CaptureHit & { key: string; meta: CaptureMeta } => hit !== null)
      .sort(
        (left, right) =>
          left.meta.updatedAt.localeCompare(right.meta.updatedAt) || left.index - right.index,
      );
    let sessionActivity: string | null = null;
    for (const hit of ordered) {
      seen.add(hit.key);
      const previous = this.#live.get(hit.key);
      if (previous && previous.hash === hit.meta.hash) {
        assignMeta(previous, hit.meta);
        continue;
      }
      const updatedAt = hit.meta.updatedAt;
      if (
        updatedAt &&
        (sessionActivity === null || Date.parse(updatedAt) > Date.parse(sessionActivity))
      ) {
        sessionActivity = updatedAt;
      }
      this.#live.set(hit.key, {
        ...hit.meta,
        schedule: noteActivity(previous?.schedule ?? emptySchedule(), now),
      });
    }
    if (sessionActivity) this.#noteActivity(sessionActivity);
    for (const key of this.#live.keys()) {
      if (!seen.has(key)) this.#live.delete(key);
    }
    const visited = new Set(hits.map((hit) => hit.path));
    for (const hit of hits) {
      // An unchanged hit carries no metadata. Keep what the file earned on an earlier
      // scan, or the next restart would have fingerprints but nothing to restore.
      const known = hit.meta ?? this.#files.get(hit.path)?.meta;
      this.#files.set(hit.path, {
        stamp: hit.stamp,
        key: hit.key,
        generation,
        ...(known ? { meta: known } : {}),
      });
    }
    for (const path of this.#files.keys()) {
      if (!visited.has(path)) this.#files.delete(path);
    }
    this.#lastScanParsed = hits.filter((hit) => !hit.unchanged).length;
    this.#rememberCaptureFiles();
    this.#scannedOnce = true;
  }

  /**
   * Puts the sessions from the stored fingerprints back into the live map.
   *
   * A session the store has no `file_id` for is queued for upload: it was captured but
   * never reached Drive, which is the normal state after a long offline or signed-out
   * period. Everything else is marked as already uploaded, so a restart does not push
   * every session again; a file that changed still gets a new hash on the next scan,
   * which is what marks it dirty.
   */
  #restoreLiveFromFiles(): void {
    for (const cursor of this.#files.values()) {
      if (!cursor.key || !cursor.meta) continue;
      const at = Date.parse(cursor.meta.updatedAt);
      const stamp = Number.isNaN(at) ? this.#clock.nowMs() : at;
      const uploaded = (this.#store?.getSession(cursor.key)?.fileId ?? null) !== null;
      this.#live.set(cursor.key, {
        ...cursor.meta,
        schedule: uploaded
          ? { lastActivityAt: stamp, lastUploadAt: stamp, dirtySince: null }
          : { lastActivityAt: stamp, lastUploadAt: null, dirtySince: stamp },
      });
    }
  }

  /** Persists the fingerprints so a restart does not re-parse the whole library. */
  #rememberCaptureFiles(): void {
    if (!this.#store) return;
    try {
      this.#store.setCursor(CAPTURE_FILES_CURSOR, JSON.stringify([...this.#files]));
    } catch {
      // A failed write only costs an extra full scan after the next restart.
    }
  }

  #captureCursors(): Record<string, CaptureCursorInput> {
    const cursors: Record<string, CaptureCursorInput> = {};
    for (const [path, cursor] of this.#files) {
      const live = cursor.key ? this.#live.get(cursor.key) : undefined;
      cursors[path] = {
        stamp: cursor.stamp,
        key: cursor.key,
        generation: cursor.generation,
        sourcePath: live?.sourcePath ?? null,
      };
    }
    return cursors;
  }

  async #scanInWorker(request: CaptureScanRequest): Promise<CaptureHit[]> {
    const directory = this.#paths.dataDir;
    const requestPath = join(directory, "capture-request.json");
    const resultPath = join(directory, "capture-result.json");
    await Bun.write(requestPath, JSON.stringify(request));
    let child: ReturnType<typeof Bun.spawn> | null = null;
    try {
      child = Bun.spawn([process.execPath, "daemon"], {
        env: {
          ...this.#env,
          YOU_BRAIN_CAPTURE_WORKER: "1",
          YOU_BRAIN_CAPTURE_REQUEST: requestPath,
          YOU_BRAIN_CAPTURE_RESULT: resultPath,
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        signal: this.#abort.signal,
      });
      const stderrStream = child.stderr;
      const stderr =
        stderrStream && typeof stderrStream !== "number"
          ? await new Response(stderrStream).text()
          : "";
      const code = await child.exited;
      if (code !== 0) {
        throw new Error(stderr.trim() || `capture worker exited ${code}`);
      }
      return JSON.parse(await Bun.file(resultPath).text()) as CaptureHit[];
    } finally {
      await unlink(requestPath).catch(() => undefined);
      await unlink(resultPath).catch(() => undefined);
    }
  }

  async #materialize(live: LiveSession): Promise<NormalizedSession | null> {
    const parsed = await parseSourceFile(live.source, live.sourcePath, {
      device: live.device,
      includeSubagents: live.includeSubagents,
      keepToolCalls: live.keepToolCalls,
      signal: this.#abort.signal,
    });
    if (!parsed.session) return null;
    return applyCaptureRedaction(parsed.session, {
      redact: live.redact,
      redaction: {},
    }).session;
  }

  /**
   * Records inbox files to index and returns. Downloads happen later in `#drainInbox`,
   * so a pull can publish `lastSyncAt` without waiting on the whole inbox.
   */
  #enqueueInbox(files: readonly DriveEntry[]): void {
    const store = this.#store;
    if (!store || files.length === 0) return;
    // Recorded before the scope filter: a device that is not the web processor never
    // downloads these files, but the status page still has to say they are waiting.
    const sawWeb = files.some((file) => isWebInboxPath(file.path));
    if (sawWeb !== (store.getCursor(WEB_INBOX_SEEN_CURSOR) === "1")) {
      store.setCursor(WEB_INBOX_SEEN_CURSOR, sawWeb ? "1" : "0");
    }
    const scope = this.#inboxScope();
    const queued = readInboxPending(store).filter((item) => inScope(item.path, scope));
    const indexById = new Map(queued.map((item, index) => [item.id, index]));
    let changed = false;
    for (const file of files) {
      if (!isInboxSessionFile(file)) continue;
      if (!inScope(file.path, scope)) continue;
      if (store.getCursor(inboxIndexedKey(file.id)) === file.modifiedTime) continue;
      const next: InboxPendingFile = {
        id: file.id,
        path: file.path,
        modifiedTime: file.modifiedTime,
      };
      if (file.mimeType) next.mimeType = file.mimeType;
      const at = indexById.get(file.id);
      if (at === undefined) {
        indexById.set(file.id, queued.length);
        queued.push(next);
        changed = true;
        continue;
      }
      const current = queued[at];
      if (!current || next.modifiedTime < current.modifiedTime) continue;
      if (
        current.modifiedTime === next.modifiedTime &&
        current.path === next.path &&
        current.mimeType === next.mimeType
      ) {
        continue;
      }
      queued[at] = next;
      changed = true;
    }
    if (!changed) return;
    writeInboxPending(store, queued);
    this.#inboxDirty = true;
  }

  /**
   * Indexes a slice of `inbox.pending`. Each file is tried at most once per call.
   * A read that throws stays queued. The clock budget stops the pass after a batch.
   */
  async #drainInbox(options: { budgetMs: number }): Promise<void> {
    const drive = this.#drive;
    const store = this.#store;
    if (!drive || !store) return;
    const started = this.#clock.nowMs();
    const scope = this.#inboxScope();
    let rest = readInboxPending(store).filter(
      (file) =>
        inScope(file.path, scope) &&
        store.getCursor(inboxIndexedKey(file.id)) !== file.modifiedTime,
    );
    const failed: InboxPendingFile[] = [];
    let progressed = false;
    try {
      while (rest.length > 0) {
        if (this.#stopped || this.#drive !== drive) break;
        const batch = rest.slice(0, INBOX_READ_CONCURRENCY);
        rest = rest.slice(batch.length);
        // Downloads run together; rows are written one by one in listing order.
        const results = await Promise.all(
          batch.map(async (file) => {
            try {
              const object = await drive.read(file.id);
              return { file, text: object.bytes.toString("utf8"), ok: true as const };
            } catch {
              return { file, text: "", ok: false as const };
            }
          }),
        );
        for (const result of results) {
          if (!result.ok) {
            failed.push(result.file);
            continue;
          }
          this.#indexInboxFile(store, inboxPendingEntry(result.file), result.text);
          if (result.file.modifiedTime) {
            store.setCursor(inboxIndexedKey(result.file.id), result.file.modifiedTime);
          }
          progressed = true;
        }
        if (this.#clock.nowMs() - started >= options.budgetMs) break;
      }
    } finally {
      const pending = [...failed, ...rest];
      try {
        writeInboxPending(store, pending);
        this.#inboxDirty = pending.length > 0;
      } catch {
        this.#inboxDirty = true;
      }
      if (progressed) {
        this.#output?.schedule();
        this.changes.publish("today", this.#clock.now().toISOString());
      }
    }
  }

  /** A device that just became the web processor never downloaded the plugin files. Queue them once. */
  async #catchUpWebInbox(): Promise<void> {
    const drive = this.#drive;
    if (!drive) return;
    try {
      const entries = await drive.list({ prefix: "inbox/" });
      this.#enqueueInbox(entries.filter((entry) => isWebInboxPath(entry.path)));
    } catch {
      // The next role change or a re-listed change feed queues them again.
    }
  }

  /** This device downloads its own sessions, plus browser-plugin files when it refines them. */
  #inboxScope(): string[] {
    return inboxScopePrefixes({
      device: this.#local.displayName,
      includeWeb: resolveWebProcessor(this.#roles) === this.#local.deviceId,
    });
  }

  /** Writes one inbox file into the sessions table. A malformed file is skipped. */
  #indexInboxFile(store: SqliteStore, file: DriveEntry, text: string): void {
    try {
      const fields = frontmatter(text);
      const source = fields.get("source");
      const conversationId = fields.get("conversation_id");
      const startedAt = fields.get("started_at");
      const web = isWebInboxPath(file.path);
      const updatedAt = fields.get("updated_at") || (web ? file.modifiedTime : "");
      if (!source || !conversationId || !startedAt || !updatedAt) return;
      const declared = Number(fields.get("turn_count") ?? "");
      // A browser plugin may omit turn_count. Count turns from the body so the session is not stuck at 0.
      const turnCount =
        Number.isInteger(declared) && declared >= 0 && fields.has("turn_count")
          ? declared
          : web
            ? (parseWebSession(text)?.turnCount ?? 0)
            : 0;
      const sessionKey = conversationKey(source, conversationId);
      const before = store.getSession(sessionKey);
      store.upsertSession({
        sessionKey,
        source,
        device: fields.get("device") || this.#local.displayName,
        startedAt,
        updatedAt,
        fileId: file.id,
        msgCount: Number.isInteger(turnCount) && turnCount >= 0 ? turnCount : 0,
      });
      if (!web) return;
      const after = store.getSession(sessionKey);
      const identityChanged = rememberWebInbox(store, sessionKey, {
        fileId: file.id,
        path: file.path,
      });
      const bytesChanged =
        before !== null &&
        after !== null &&
        (before.msgCount !== after.msgCount || before.updatedAt !== after.updatedAt);
      if (identityChanged || bytesChanged) this.#retry.succeed(sessionKey);
    } catch {
      // Skip a malformed inbox file and keep pulling.
    }
  }

  async #emitCopied(event: Event): Promise<void> {
    if (this.#sync) {
      await appendCopied(this.#sync, event);
      this.#scheduleWebhook();
      return;
    }
    if (!this.#log || !this.#store) return;
    const allocated = allocateCopied(this.#log, event);
    this.#enqueueLocal(allocated);
    persistTopicBook(this.#store, applyEvents(foldEvents(this.#store.listEvents()), [allocated]));
    this.#onTopicsChanged();
    this.#scheduleWebhook();
  }

  async #emitUser<T extends EventType>(type: T, data: EventOf<T>["data"]): Promise<void> {
    if (this.#sync) {
      await this.#sync.append(type, data);
      this.#scheduleWebhook();
      return;
    }
    if (!this.#log || !this.#store) return;
    const event = this.#log.allocate(type, data);
    this.#enqueueLocal(event);
    persistTopicBook(this.#store, applyEvents(foldEvents(this.#store.listEvents()), [event]));
    this.#onTopicsChanged();
    this.#scheduleWebhook();
  }

  /** Drive may still be closed. Queue the event so the first flush replicates it. */
  #enqueueLocal(event: Event): void {
    const store = this.#store;
    if (!store) return;
    const queue = readOutboxQueue(store, this.#local.deviceId);
    queue.push(event);
    writeOutboxQueue(store, this.#local.deviceId, queue);
    store.enqueueOutbox({
      id: event.id,
      kind: "event",
      payload: event,
      createdAt: event.ts,
    });
  }

  #onTopicsChanged(): void {
    this.#output?.schedule();
    const at = this.#clock.now().toISOString();
    this.changes.publish("topics", at);
    this.changes.publish("today", at);
    this.changes.publish("status", at);
    this.#markTopicFilesDirty();
  }

  #canWriteTopicFiles(): boolean {
    return (
      this.#drive !== null &&
      this.#roles.consolidation.enabled &&
      this.#roles.mainDevice === this.#local.deviceId
    );
  }

  #markTopicFilesDirty(): void {
    if (!this.#canWriteTopicFiles()) return;
    this.#topicFilesDirty = true;
    this.#topicFilesEpoch += 1;
    this.#topicFilesQuietUntil = this.#clock.nowMs() + INTERVALS.topicFilesDebounceMs;
  }

  /** One topic-file sync at a time. A later caller waits, then runs against the latest book. */
  async #writeTopicFiles(): Promise<TopicFilesResult> {
    const previous = this.#topicFilesLock;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#topicFilesLock = gate;
    await previous;
    try {
      return await this.#writeTopicFilesBody();
    } finally {
      release();
    }
  }

  async #writeTopicFilesBody(): Promise<TopicFilesResult> {
    const drive = this.#drive;
    const store = this.#store;
    if (!drive || !store || !this.#canWriteTopicFiles()) return emptyTopicFilesResult();
    const epoch = this.#topicFilesEpoch;
    const view = this.#consolidationView();
    const result = await syncTopicFiles({
      drive,
      book: view.book,
      language: this.#shared.ui.language,
      timeZone: this.#roles.timezone,
      zone: {
        now: this.#clock.now().toISOString(),
        activeLimit: this.#shared.topics.activeLimit,
        historyDays: this.#shared.topics.historyDays,
        ...(Object.keys(view.sessionUpdatedAt).length > 0
          ? { sessionUpdatedAt: view.sessionUpdatedAt }
          : {}),
      },
      manifest: {
        get: () => store.getCursor(TOPIC_FILES_MANIFEST),
        set: (value) => {
          store.setCursor(TOPIC_FILES_MANIFEST, value);
        },
      },
    });
    if (result.failed > 0) {
      this.#topicFilesDirty = true;
      this.#topicFilesQuietUntil = this.#clock.nowMs() + INTERVALS.topicFilesDebounceMs;
      return result;
    }
    if (this.#topicFilesEpoch === epoch) {
      this.#topicFilesDirty = false;
      this.#topicFilesQuietUntil = null;
    }
    return result;
  }

  async #issueReminders(): Promise<void> {
    const store = this.#store;
    if (this.#stopped || !store || !this.#log) return;
    const now = this.#clock.now();
    const sessionUpdatedAt: Record<string, string> = {};
    for (const session of store.listSessions()) {
      if (session.updatedAt !== null) sessionUpdatedAt[session.sessionKey] = session.updatedAt;
    }
    const events = store.listEvents();
    const due = dueRemindersForDevice({
      deviceId: this.#local.deviceId,
      mainDevice: this.#roles.mainDevice,
      notifications: this.#shared.reminders.notifications,
      events,
      sessionUpdatedAt,
      activeLimit: this.#shared.topics.activeLimit,
      historyDays: this.#shared.topics.historyDays,
      morningDigestTime: this.#shared.reminders.morningDigestTime,
      weeklyReviewDay: this.#shared.reminders.weeklyReviewDay,
      weeklyReviewTime: this.#shared.reminders.weeklyReviewTime,
      now: now.toISOString(),
      timeZoneOffsetMinutes: timeZoneOffsetMinutes(this.#roles.timezone, now),
      mergeLines: mergeSuggestionLines(
        parseMergeSuggestions(store.getCursor(MERGE_SUGGESTIONS_CURSOR)),
        foldEvents(events).topics,
      ),
    });
    for (const item of due) {
      if (this.#stopped) return;
      await this.#emitUser("reminder.issued", item);
    }
  }

  /** A disabled file with no cursor must not backfill events from before this start. */
  #armWebhookWindow(): void {
    const store = this.#store;
    if (!store || !this.#webhook.enabled) return;
    const state = parseWebhookState(store.getCursor(WEBHOOK_STATE_CURSOR));
    if (state.enabledAt !== null) return;
    state.enabledAt = this.#clock.now().toISOString();
    store.setCursor(WEBHOOK_STATE_CURSOR, serializeWebhookState(state));
  }

  #markWebhookEnabled(at: string): void {
    const store = this.#store;
    if (!store) return;
    const state = parseWebhookState(store.getCursor(WEBHOOK_STATE_CURSOR));
    state.enabledAt = at;
    store.setCursor(WEBHOOK_STATE_CURSOR, serializeWebhookState(state));
  }

  /** One in flight. A timer that is already waiting is left alone so the wait stays ≤ 2s. */
  #scheduleWebhook(): void {
    if (this.#stopped || !this.#webhook.enabled) return;
    if (this.#roles.mainDevice !== this.#local.deviceId) return;
    if (this.#webhookTimer) return;
    this.#webhookTimer = this.#clock.schedule(INTERVALS.webhookDebounceMs, () => {
      this.#webhookTimer = null;
      return this.#runWebhook().catch(() => undefined);
    });
  }

  #runWebhook(): Promise<void> {
    return this.#enqueueWebhook(() => this.#deliverWebhook());
  }

  #enqueueWebhook<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#webhookChain.then(fn, fn);
    this.#webhookChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #deliverWebhook(): Promise<void> {
    if (this.#stopped) return;
    const store = this.#store;
    if (!store || !this.#webhook.enabled) return;
    if (this.#roles.mainDevice !== this.#local.deviceId) return;
    const result = await runWebhookDelivery({
      events: store.listEventsByType(this.#webhook.events),
      state: parseWebhookState(store.getCursor(WEBHOOK_STATE_CURSOR)),
      now: this.#clock.now(),
      config: this.#webhook,
      fetch: this.#webhookFetch,
      signal: this.#abort.signal,
    });
    if (this.#store !== store) return;
    store.setCursor(WEBHOOK_STATE_CURSOR, serializeWebhookState(result.state));
    const error = result.state.last?.error;
    if (result.failed > 0 && error) console.error(`webhook: ${error}`);
  }

  async #writeWebhook(body: WebhookPutBody): Promise<WebhookPublic> {
    const next = applyWebhookUpdate(this.#webhook, {
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.url !== undefined ? { url: body.url } : {}),
      ...(body.secret !== undefined ? { secret: body.secret } : {}),
      ...(body.events !== undefined ? { events: body.events } : {}),
    });
    const turningOn = next.enabled && !this.#webhook.enabled;
    await writeWebhookConfig(webhookConfigPath(this.#paths.dataDir), next);
    this.#webhook = next;
    if (turningOn) this.#markWebhookEnabled(this.#clock.now().toISOString());
    if (next.enabled) this.#scheduleWebhook();
    return this.#webhookView();
  }

  #webhookView(): WebhookPublic {
    const store = this.#store;
    const state = store
      ? parseWebhookState(store.getCursor(WEBHOOK_STATE_CURSOR))
      : emptyWebhookState();
    const pending =
      this.#webhook.enabled && store
        ? countWebhookPending(
            store.listEventsByType(this.#webhook.events),
            state,
            this.#webhook.events,
          )
        : 0;
    return {
      enabled: this.#webhook.enabled,
      url: this.#webhook.url,
      hasSecret: this.#webhook.secret !== "",
      events: [...this.#webhook.events],
      active: this.#webhook.enabled && this.#roles.mainDevice === this.#local.deviceId,
      last: state.last,
      pending,
    };
  }

  async #testWebhook(): Promise<WebhookTestResult> {
    const url = this.#webhook.url;
    if (url === "") throw new YouBrainError("INVALID_INPUT", "还没有保存 Webhook URL");
    const problem = webhookUrlProblem(url);
    if (problem) throw new YouBrainError("INVALID_INPUT", problem);
    const now = this.#clock.now();
    const result = await postWebhook({
      url,
      secret: this.#webhook.secret,
      payload: {
        id: `test-${ulid(now.getTime())}`,
        type: "webhook.test",
        occurredAt: now.toISOString(),
        deviceId: this.#local.deviceId,
        data: {},
      },
      fetch: this.#webhookFetch,
      now,
      signal: this.#abort.signal,
    });
    if (result.ok) return { ok: true, status: result.status };
    if (result.reason === "aborted") {
      return { ok: false, error: `${webhookErrorHost(url)}: 连接失败` };
    }
    if (result.reason === "http") return { ok: false, status: result.status, error: result.error };
    return { ok: false, error: result.error };
  }

  async #onConfigChanged(update: {
    shared?: SharedConfig;
    roles?: Roles;
    removedDevices?: string[];
  }): Promise<void> {
    if (update.shared) {
      this.#shared = preferLocalLlm(update.shared, this.#shared);
      this.#clearCliStall();
      await writeJsonFile(join(this.#paths.dataDir, "shared.json"), this.#shared);
      this.#applyZone();
      this.#mountOutput();
      this.#portrait?.setConfig({
        variants: this.#shared.portrait.variants,
        snapshotPattern: this.#shared.portrait.snapshotPattern,
      });
      if (this.#llmOverride === undefined) this.#llm = await this.#createLlm();
      await this.#rewatch();
      await this.#ensureCoding();
      await this.#mountSearch();
    }
    if (update.roles) {
      const wasWebProcessor = resolveWebProcessor(this.#roles) === this.#local.deviceId;
      this.#roles = update.roles;
      await writeJsonFile(join(this.#paths.dataDir, "roles.json"), this.#roles);
      this.#applyZone();
      this.#mountOutput();
      if (!wasWebProcessor && resolveWebProcessor(this.#roles) === this.#local.deviceId) {
        await this.#catchUpWebInbox();
      }
    }
    this.changes.publish("status", this.#clock.now().toISOString());
    if (update.removedDevices?.length) this.changes.publish("devices", this.#clock.now().toISOString());
  }

  async #heartbeat(): Promise<void> {
    if (this.#sync) {
      try {
        await this.#sync.heartbeat({ lastActiveAt: this.#activityForDevice() });
        this.#driveReachable = true;
      } catch {
        this.#driveReachable = false;
      }
      this.#retryConfigPush();
    }
    this.#rememberDevice();
    // Open pages only learn the new lastSeenAt from this event. Without it they show this device offline.
    this.changes.publish("devices", this.#clock.now().toISOString());
  }

  #loadPreservedActivity(): void {
    if (this.#preservedLoaded || !this.#store) return;
    this.#preservedActivityAt = this.#store.getDevice(this.#local.deviceId)?.lastActiveAt ?? null;
    this.#preservedLoaded = true;
  }

  /** Keep the newest real activity. Older session discoveries do not move it backward. */
  #noteActivity(at: string): void {
    const ms = Date.parse(at);
    if (Number.isNaN(ms)) return;
    const floorMs = Date.parse(this.#activityForDevice());
    if (!Number.isNaN(floorMs) && ms <= floorMs) return;
    this.#lastActivityAt = new Date(ms).toISOString();
    this.#rememberDevice();
  }

  /**
   * Newest of this process, the startup row, and the current device row.
   * Epoch when none of those is a real timestamp.
   */
  #activityForDevice(): string {
    this.#loadPreservedActivity();
    return latestActivity([
      this.#lastActivityAt,
      this.#preservedActivityAt,
      this.#store?.getDevice(this.#local.deviceId)?.lastActiveAt ?? null,
    ]);
  }

  /** 本机在 Drive 设备表里的类型。服务器模式不声明 capture：它没有可采集的 CLI 会话。 */
  #kind(): "desktop" | "server" {
    return this.#local.role === "server" ? "server" : "desktop";
  }

  #capabilities(): Array<"capture" | "refine" | "consolidate"> {
    return this.#local.role === "server" ? ["refine", "consolidate"] : ["capture", "refine"];
  }

  #rememberDevice(): void {
    if (!this.#store) return;
    const now = this.#clock.now().toISOString();
    this.#store.upsertDevice({
      deviceId: this.#local.deviceId,
      displayName: this.#local.displayName,
      kind: this.#kind(),
      platform: this.#platform,
      appVersion: this.#appVersion,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: this.#capabilities(),
      lastSeenAt: now,
      lastActiveAt: this.#activityForDevice(),
    });
  }

  /**
   * Pull copies the Drive row. Keep the newer of that row and this process's
   * real activity so an older copy cannot move the timestamp backward.
   */
  #restoreLocalActivity(): void {
    if (!this.#store) return;
    const current = this.#store.getDevice(this.#local.deviceId);
    const lastActiveAt = this.#activityForDevice();
    if (!current) {
      this.#rememberDevice();
      return;
    }
    if (current.lastActiveAt === lastActiveAt) return;
    this.#store.upsertDevice({ ...current, lastActiveAt });
  }

  #identity(): DeviceIdentity {
    return {
      deviceId: this.#local.deviceId,
      displayName: this.#local.displayName,
      kind: this.#kind(),
      platform: this.#platform,
      appVersion: this.#appVersion,
      capabilities: this.#capabilities(),
    };
  }

  async #openDrive(): Promise<void> {
    if (this.#options.drive !== undefined) {
      this.#drive = this.#options.drive;
      this.#driveReachable = this.#options.drive !== null;
      return;
    }
    const opened = await openGoogleDrive({
      local: this.#local,
      configFile: this.#configFile,
      platform: this.#platform,
      interactive: false,
      secretBackend: this.#secretBackend,
      ...(this.#options.secrets ? { secrets: this.#options.secrets } : {}),
    });
    this.#drive = opened?.drive ?? null;
    if (opened) this.#local = opened.config;
    this.#driveReachable = opened !== null;
  }

  async #mountSearch(): Promise<void> {
    if (!this.#drive || !this.#paths) return;
    const semantic = this.#shared.search.semantic;
    if (this.#search && this.#searchSemantic === semantic) return;
    if (this.#embedderClose) {
      const close = this.#embedderClose;
      this.#embedderClose = null;
      await close().catch(() => undefined);
    }
    if (!this.#searchDb) {
      const database = new Database(this.#paths.stateFile);
      database.exec("PRAGMA busy_timeout = 5000");
      this.#searchDb = database;
    }
    const embedder = resolveDaemonEmbedder({
      semantic,
      ...(this.#options.embedder ? { injected: this.#options.embedder } : {}),
      openDefault: () => {
        const lazy = new LazyEmbedder(this.#paths.modelCacheDir);
        this.#embedderClose = () => lazy.close();
        return lazy;
      },
    });
    this.#searchSemantic = semantic;
    this.#search = new SearchService({
      drive: asSearchDrive(this.#drive),
      scope: () => this.#inboxScope(),
      embedder,
      database: this.#searchDb,
      semantic,
    });
  }

  #mountOutput(): void {
    if (!this.#store) return;
    this.#output?.close();
    this.#output = new OutputService({
      source: this.#store,
      paths: this.#paths,
      language: this.#shared.ui.language,
      timeZone: this.#roles.timezone,
      activeLimit: this.#shared.topics.activeLimit,
      historyDays: this.#shared.topics.historyDays,
      debounceMs: INTERVALS.outputDebounceMs,
      clock: this.#clock,
    });
  }

  #applyZone(): void {
    this.#zone.timeZone = this.#roles.timezone;
    this.#zone.activeLimit = this.#shared.topics.activeLimit;
    this.#zone.historyDays = this.#shared.topics.historyDays;
  }

  async #createLlm(): Promise<LlmBackend | null> {
    try {
      const backend = await createLlmBackend({
        config: this.#shared.llm,
        getApiKey: (provider) =>
          getLlmApiKey(provider, {
            platform: this.#platform,
            backend: this.#secretBackend,
          }),
        dataDir: this.#paths.dataDir,
        env: this.#env,
        homeDir: this.#homeDir,
        ...(this.#options.llmTimeoutMs === undefined
          ? {}
          : { timeoutMs: this.#options.llmTimeoutMs }),
      });
      this.#llmWarning = null;
      return backend;
    } catch (error) {
      this.#llmWarning = describeLlmSetupFailure(this.#shared.llm.provider, error);
      return null;
    }
  }

  async #writeLlmKey(body: LlmKeyPutBody): Promise<void> {
    await setLlmApiKey(body.provider, body.apiKey, {
      platform: this.#platform,
      backend: this.#secretBackend,
    });
    // Startup builds the backend after the key may have been stored, so only rebuild once that has happened.
    if (
      this.#llmOverride === undefined &&
      this.#llmKnown &&
      body.provider === this.#shared.llm.provider
    ) {
      this.#llm = await this.#createLlm();
      this.changes.publish("status", this.#clock.now().toISOString());
    }
  }

  /**
   * Interactive Google login from the settings page. One flow runs at a time. The request
   * stays open until the browser step finishes, fails, or the daemon stops.
   */
  async #googleLogin(): Promise<GoogleLoginResult> {
    if (this.#loginFlow) {
      throw new HttpError(409, "LOGIN_IN_PROGRESS", "登录进行中，请在浏览器完成授权");
    }
    if (this.#drive) {
      // Switching accounts is not part of this version. The current connection stays as it is.
      const email = this.#local.account.email;
      return { ok: true, message: email ? `已登录为 ${email}` : "已登录" };
    }
    if (!this.#driveKnown) {
      throw new HttpError(409, "DRIVE_STARTING", "Drive 正在启动，请稍后再试");
    }
    this.#loginFlow = this.#connectGoogle();
    try {
      const message = await this.#loginFlow;
      const authorization = this.#pendingAuthorization;
      this.#pendingAuthorization = undefined;
      return {
        ok: true,
        message,
        ...(authorization ? { authorization } : {}),
      };
    } finally {
      this.#loginFlow = null;
    }
  }

  /** Runs the browser login, then starts the Drive services here. Returns the user message. */
  async #connectGoogle(): Promise<string> {
    let opened: Awaited<ReturnType<typeof openGoogleDrive>>;
    try {
      opened = await (this.#options.googleOpen ?? openGoogleDrive)({
        local: this.#local,
        configFile: this.#configFile,
        platform: this.#platform,
        interactive: true,
        secretBackend: this.#secretBackend,
        // 服务器上没有浏览器：固定回调端口，并把链接交给界面展示。
        // daemon 的 stdout 只进 journalctl，直接写出去用户看不到。
        ...(this.#local.role === "server"
          ? {
              headless: {
                onAuthorizationUrl: (info: { url: string; tunnel: string | null }) => {
                  this.#pendingAuthorization = info;
                  // 登录接口会阻塞到授权完成，界面靠这次推送拿到链接。
                  this.changes.publish("status", this.#clock.now().toISOString());
                },
              },
            }
          : {}),
        ...(this.#options.secrets ? { secrets: this.#options.secrets } : {}),
        // Stop cancels the browser wait, so the callback server does not hold the process open.
        signal: this.#abort.signal,
      });
    } catch (error) {
      if (error instanceof YouBrainError) throw new HttpError(409, error.code, error.message);
      throw error;
    }
    if (!opened) throw new HttpError(409, "AUTH_REQUIRED", "Google 登录未完成");
    if (this.#stopped) {
      // openGoogleDrive has already saved the grant, so the next start picks it up.
      throw new HttpError(503, "DAEMON_STOPPING", "daemon 正在停止，授权已保存，重启后生效");
    }
    const owner = this.#store?.getCursor(DRIVE_ACCOUNT_CURSOR) ?? null;
    const picked = opened.config.account.permissionId;
    if (owner && picked && owner !== picked) {
      // Local data belongs to the account that signed out. Mixing two accounts would upload
      // one person's sessions into another's Drive, so the new grant is dropped again.
      const pickedEmail = opened.config.account.email;
      await this.#dropGrant();
      throw new HttpError(
        409,
        "ACCOUNT_MISMATCH",
        `本机数据属于另一个 Google 账号，${pickedEmail || "这个账号"}未登录。要换账号，请使用「切换账号」，本机数据会先备份。`,
      );
    }
    this.#local = opened.config;
    this.#drive = opened.drive;
    try {
      // Same portrait paths as start(). The consent store is file-backed, so a new instance is equivalent.
      await this.#connectDrive(
        createStartupLog(() => undefined),
        new FilePortraitConsentStore(portraitConsentPath(this.#paths.dataDir)),
        join(this.#paths.dataDir, "managed-blocks.json"),
      );
    } catch (error) {
      this.#driveReachable = false;
      console.error(`login: drive ${error instanceof Error ? error.message : "failed"}`);
    }
    this.changes.publish("status");
    // Pulls what Drive already has. A failure shows in status and does not fail the login.
    void this.#syncNow().catch(() => undefined);
    const email = opened.config.account.email;
    return email ? `已使用 ${email} 登录` : "已登录";
  }

  #secretStore(): SecretStore {
    return (
      this.#options.secrets ??
      createConfigSecretStore({
        platform: this.#platform,
        configFile: this.#configFile,
        backend: this.#secretBackend,
      })
    );
  }

  /** Deletes the stored grant and the Drive binding in the config file. Local data stays. */
  async #dropGrant(): Promise<boolean> {
    const revoked = await signOutGoogle({
      secrets: this.#secretStore(),
      ...(this.#options.revokeFetch ? { fetcher: this.#options.revokeFetch } : {}),
    });
    this.#local = clearGoogleConnection(this.#local);
    await writeLocalConfig(this.#configFile, this.#local);
    return revoked;
  }

  /** Stops every Drive-backed service. The next login builds them again. */
  #unmountDrive(): void {
    this.#sync = null;
    this.#uploader = null;
    this.#portrait = null;
    this.#search = null;
    this.#searchSemantic = null;
    this.#drive = null;
    this.#driveReachable = false;
  }

  /**
   * Signs out of Google and keeps all local data. The account is remembered so a later
   * login can only resume with the same one. Returns null when nobody was signed in.
   */
  async #signOut(): Promise<{ email: string; revoked: boolean } | null> {
    if (this.#loginFlow) {
      throw new HttpError(409, "LOGIN_IN_PROGRESS", "登录进行中，请先在浏览器完成或取消授权");
    }
    if (!this.#driveKnown) {
      throw new HttpError(409, "DRIVE_STARTING", "Drive 正在启动，请稍后再试");
    }
    return this.#run(async () => {
      const store = this.#store;
      if (!store) throw new HttpError(503, "DAEMON_STOPPING", "daemon 正在停止");
      const account = this.#local.account;
      if (!this.#drive && account.email === "") return null;
      this.#unmountDrive();
      if (account.permissionId) store.setCursor(DRIVE_ACCOUNT_CURSOR, account.permissionId);
      const revoked = await this.#dropGrant();
      this.changes.publish("status");
      return { email: account.email, revoked };
    });
  }

  async #googleLogout(): Promise<GoogleLogoutResult> {
    const done = await this.#signOut();
    if (!done) return { ok: true, message: "当前没有登录的 Google 账号" };
    const who = done.email ? `已退出 ${done.email}` : "已退出";
    return {
      ok: true,
      message: done.revoked
        ? `${who}，本机数据已保留`
        : `${who}，本机数据已保留；未能通知 Google 撤销授权，可在 Google 账号的安全设置里手动移除`,
    };
  }

  /**
   * Signs out, then backs the local state up and restarts clean, so the next login can use
   * any account. The response goes out first; the restart follows once it has been sent.
   * Whoever supervises the daemon starts it again (the desktop app does).
   */
  async #googleSwitch(): Promise<GoogleLogoutResult> {
    await this.#signOut();
    this.#resetStateOnStop = true;
    setTimeout(() => {
      void this.stop();
    }, 200).unref();
    return {
      ok: true,
      message: "已退出，本机数据已备份。后台正在重启，请稍后重新登录并选择账号",
    };
  }

  /**
   * 自带 OAuth 凭据的读写。
   *
   * 分发方式：每个人用自己的 Google Cloud 项目，不走内置官方凭据。secret 写进密钥
   * 后端（桌面是钥匙串，服务器是 0600 文件），不回显。
   */
  #oauthClientSecretStore(): SecretStore {
    return createOAuthClientSecretStore({
      platform: this.#platform,
      configFile: this.#configFile,
      backend: this.#secretBackend,
    });
  }

  async #oauthClientView(): Promise<OAuthClientPublic> {
    const officialAvailable = isUsableOfficialOAuthClient(resolveOfficialOAuthClient(this.#env));
    let hasClientSecret = false;
    if (this.#local.oauth.mode === "custom") {
      const stored = await this.#oauthClientSecretStore().get().catch(() => null);
      hasClientSecret = Boolean(stored?.trim());
    }
    return {
      mode: this.#local.oauth.mode,
      clientId: this.#local.oauth.clientId,
      hasClientSecret,
      officialAvailable,
    };
  }

  async #writeOAuthClient(body: OAuthClientPutBody): Promise<OAuthClientPublic> {
    if (this.#loginFlow) {
      throw new HttpError(409, "LOGIN_IN_PROGRESS", "登录进行中，请先在浏览器完成或取消授权");
    }
    const secrets = this.#oauthClientSecretStore();
    let next = this.#local;
    try {
      if (body.mode === "official") {
        // 切回官方：删掉自己的 secret，config 里不再留 client id。
        if (this.#local.oauth.mode === "custom") {
          next = await clearUserOAuthCredentials({ config: this.#local, secrets });
        } else {
          next = { ...this.#local, oauth: { mode: "official", clientId: "" } };
        }
      } else if (body.clientSecret) {
        next = await saveUserOAuthCredentials({
          config: this.#local,
          clientId: body.clientId ?? this.#local.oauth.clientId,
          clientSecret: body.clientSecret,
          secrets,
        });
      } else {
        // 只改 id，沿用已存的 secret。
        next = await updateUserOAuthClientId({
          config: this.#local,
          clientId: body.clientId ?? this.#local.oauth.clientId,
          secrets,
        });
      }
    } catch (error) {
      if (error instanceof YouBrainError) {
        throw new HttpError(400, error.code, error.message);
      }
      throw error;
    }
    this.#local = next;
    await writeLocalConfig(this.#configFile, next);
    this.changes.publish("status", this.#clock.now().toISOString());
    return this.#oauthClientView();
  }

  /** Minimal connection check. Uses the request's values and never writes them to shared config. */
  async #testLlm(body: LlmTestBody): Promise<LlmTestResult> {
    if (LLM_PRESETS[body.provider].requiresApiKey) {
      const key = await getLlmApiKey(body.provider, {
        platform: this.#platform,
        backend: this.#secretBackend,
      });
      if (!key) return { ok: false, message: "还没有这个服务商的 API Key。" };
    }
    try {
      const backend = await createLlmBackend({
        config: { provider: body.provider, model: body.model, baseUrl: body.baseUrl },
        getApiKey: (provider) =>
          getLlmApiKey(provider, {
            platform: this.#platform,
            backend: this.#secretBackend,
          }),
        dataDir: this.#paths.dataDir,
        env: this.#env,
        homeDir: this.#homeDir,
      });
      await backend.test();
      return { ok: true, message: "连接成功，模型有响应。" };
    } catch (error) {
      return { ok: false, message: describeLlmSetupFailure(body.provider, error).message };
    }
  }

  #deps(): HttpDeps {
    const store = this.#store;
    if (!store) throw new YouBrainError("INVALID_INPUT", "store is not open");
    const readers = createStoreReaders(store, this.#zone);
    return {
      today: () => readers.today(),
      topics: async (query) => {
        const response = await readers.topics(query);
        return { ...response, topics: withSessionCounts(response.topics, store.listSessions()) };
      },
      topic: (id) => readers.topic(id),
      todo: (todoId) => readers.todo(todoId),
      portrait: (variant) => readPortraitFile(this.#paths.portraitDir, variant),
      portraitSnapshots: () =>
        listPortraitSnapshots(
          this.#paths.portraitDir,
          this.#shared.portrait.snapshotPattern,
        ),
      portraitCorrections: async (variant) =>
        portraitCorrectionViews(
          store.listEventsByType(["portrait.correction", "portrait.correction_applied"]),
          variant,
        ),
      search: (query) => this.#searchLocal(query),
      devices: () => readers.devices(),
      registerVirtualDevice: async (record) => {
        const sync = this.#sync;
        if (!sync) throw new HttpError(503, "DRIVE_UNAVAILABLE", "Drive 未就绪");
        return sync.registerVirtual(record);
      },
      removeVirtualDevice: async (deviceId) => {
        const sync = this.#sync;
        if (!sync) throw new HttpError(503, "DRIVE_UNAVAILABLE", "Drive 未就绪");
        await sync.removeDevice(deviceId);
      },
      readRoles: async () => this.#roles,
      writeRoles: (roles) => this.#writeRoles(roles),
      readConfig: async () => this.#shared,
      writeConfig: (config) => this.#writeConfig(config),
      readWebhook: () => Promise.resolve(this.#webhookView()),
      writeWebhook: (body) => this.#enqueueWebhook(() => this.#writeWebhook(body)),
      testWebhook: () => this.#testWebhook(),
      writeLlmKey: (body) => this.#writeLlmKey(body),
      testLlm: (body) => this.#testLlm(body),
      googleLogin: () => this.#googleLogin(),
      googleLogout: () => this.#googleLogout(),
      googleSwitch: () => this.#googleSwitch(),
      readOAuthClient: () => this.#oauthClientView(),
      writeOAuthClient: (body) => this.#writeOAuthClient(body),
      notionStatus: () => this.#requireNotion().status(),
      notionTest: () => this.#requireNotion().testConnection(),
      writeNotionKey: async (body) => {
        const notion = this.#requireNotion();
        await notion.setToken(body.token);
        // 保存令牌后立刻同步一次,界面马上有数据。
        try {
          await notion.sync();
        } catch {
          // 首次同步失败不打断保存;错误显示在状态里。
        }
        this.changes.publish("notion", this.#clock.now().toISOString());
        this.changes.publish("status", this.#clock.now().toISOString());
      },
      notionSync: async () => {
        const summary = await this.#requireNotion().sync();
        this.changes.publish("notion", this.#clock.now().toISOString());
        return summary;
      },
      notionTree: async () => ({ roots: await this.#requireNotion().tree() }),
      notionPage: (pageId) => this.#requireNotion().page(pageId),
      notionSearch: (query, limit) => {
        const hits = this.#requireNotion().search(query, limit ?? 20);
        return Promise.resolve({ query, hits });
      },
      notionDatabase: (databaseId) =>
        Promise.resolve(this.#requireNotion().databaseView(databaseId)),
      notionAsset: (blockId) => this.#requireNotion().asset(blockId),
      notionUpdateBlock: async (body) => ({
        page: await this.#requireNotion().updateBlock(body.blockId, body.markdown, body.kind, body.checked),
      }),
      notionAppendBlock: async (body) => ({
        page: await this.#requireNotion().appendBlock(body),
      }),
      notionDeleteBlock: async (body) => ({
        page: await this.#requireNotion().deleteBlock(body.blockId),
      }),
      notionMoveBlock: async (body) => ({
        page: await this.#requireNotion().moveBlock(body.blockId, body.direction),
      }),
      notionDuplicateBlock: async (body) => ({
        page: await this.#requireNotion().duplicateBlock(body.blockId),
      }),
      notionPatchTitle: async (body) => ({
        page: await this.#requireNotion().patchTitle(body.pageId, body.title),
      }),
      status: () => this.#status(),
      sync: () => this.#syncNow(),
      upload: (input) => this.#uploadNow(input),
      consolidate: (input) => this.#run(() => this.#consolidate({ manual: true, force: input.force === true })),
      reminders: async (all) => {
        const body = await readers.reminders(all);
        return {
          ...body,
          delivery: decideDelivery({
            notifications: this.#shared.reminders.notifications,
            deviceId: this.#local.deviceId,
            lastActivityAt: this.#lastActivityAt,
            devices: store.listDevices(),
            now: this.#clock.now().toISOString(),
          }),
        };
      },
      reminder: (id) => readers.reminder(id),
      reportActivity: async (at) => {
        this.#noteActivity(at);
        return { at: this.#lastActivityAt ?? this.#activityForDevice() };
      },
      now: () => this.#clock.now(),
      events: {
        emit: (type, data) => this.#emitUser(type, data),
      },
    };
  }

  async #searchLocal(query: SearchRequest) {
    assertSearchRange(query);
    if (!this.#search) {
      return {
        query: query.query,
        indexStatus: "stale" as const,
        searchMode: "keyword" as const,
        results: [],
        warnings: [],
      };
    }
    return this.#search.query({
      query: query.query,
      limit: query.limit ?? 10,
      ...(query.sources ? { sources: query.sources } : {}),
      ...(query.from ? { since: query.from } : {}),
      ...(query.to ? { until: query.to } : {}),
    });
  }

  async #writeRoles(roles: Roles): Promise<void> {
    this.#roles = roles;
    await writeJsonFile(join(this.#paths.dataDir, "roles.json"), roles);
    this.#applyZone();
    this.#mountOutput();
    if (this.#sync) this.#rolesPush.submit(roles);
    this.changes.publish("status", this.#clock.now().toISOString());
  }

  #clearCliStall(): void {
    this.#cliSilentStreak = 0;
    this.#cliStalls = 0;
    this.#cliPausedUntilMs = 0;
  }

  async #writeConfig(config: SharedConfig): Promise<void> {
    this.#shared = config;
    this.#clearCliStall();
    await writeJsonFile(join(this.#paths.dataDir, "shared.json"), config);
    this.#applyZone();
    this.#mountOutput();
    this.#portrait?.setConfig({
      variants: config.portrait.variants,
      snapshotPattern: config.portrait.snapshotPattern,
    });
    if (this.#llmOverride === undefined) this.#llm = await this.#createLlm();
    await this.#rewatch();
    await this.#ensureCoding();
    await this.#mountSearch();
    if (this.#sync) this.#sharedPush.submit(config);
    this.changes.publish("status", this.#clock.now().toISOString());
  }

  #onConfigPush(name: "shared" | "roles", failure: { error: unknown } | null): void {
    const at = this.#clock.now().toISOString();
    if (failure === null) {
      const own = this.#configPushErrors[name];
      if (own && this.#lastSyncError === own) this.#lastSyncError = null;
      this.#configPushErrors[name] = null;
    } else {
      const record = { message: describeSyncFailure(failure.error), at };
      this.#configPushErrors[name] = record;
      this.#lastSyncError = record;
    }
    this.changes.publish("status", at);
  }

  /** Test seam: waits for the config pushes in flight to finish. Production code does not call it. */
  async settleConfigPush(): Promise<void> {
    await Promise.all([this.#sharedPush.settled(), this.#rolesPush.settled()]);
  }

  #retryConfigPush(): void {
    this.#sharedPush.retry();
    this.#rolesPush.retry();
  }

  async #syncNow(): Promise<SyncActionResult> {
    const at = this.#clock.now().toISOString();
    if (!this.#sync) return { started: false, at };
    await this.#run(async () => {
      try {
        const pulled = await this.#sync?.pull();
        this.#rememberSyncSuccess();
        this.#lastPull = this.#clock.nowMs();
        if (pulled && pulled.applied > 0) this.#scheduleWebhook();
      } catch (error) {
        this.#rememberSyncFailure(error);
        throw new Error(this.#lastSyncError?.message ?? "同步失败");
      }
    });
    return { started: true, at: this.#lastSyncAt ?? at };
  }

  #rememberSyncSuccess(): void {
    this.#lastSyncAt = this.#clock.now().toISOString();
    this.#driveReachable = true;
    this.#lastSyncError = null;
  }

  #rememberSyncFailure(error: unknown): void {
    this.#driveReachable = false;
    this.#lastSyncError = {
      message: describeSyncFailure(error),
      at: this.#clock.now().toISOString(),
    };
  }

  async #uploadNow(input: UploadActionInput): Promise<UploadActionResult> {
    if (input.backfill && this.#store) this.#store.setCursor(BACKFILL_CURSOR, "pending");
    await this.scan(
      input.includeSubagents === undefined
        ? undefined
        : { includeSubagents: input.includeSubagents },
    );
    if (input.dryRun) {
      const scanned = [...this.#live.values()].filter((live) =>
        input.sources ? input.sources.includes(live.source) : true,
      ).length;
      return { dryRun: true, scanned, uploaded: 0, warnings: [] };
    }
    const result = await this.#run(() =>
      this.#processDue({
        forceIdle: true,
        ...(input.sources ? { sources: input.sources } : {}),
      }),
    );
    return {
      dryRun: false,
      scanned: result.scanned,
      uploaded: result.uploaded,
      warnings: [],
    };
  }

  /** Per-source capture state: the newest live session of each source and how many it holds. */
  #captureRows(): NonNullable<StatusResponse["captures"]> {
    const rows = new Map<
      SessionSource,
      { source: SessionSource; lastCaptureAt: string | null; sessionCount: number }
    >();
    for (const live of this.#live.values()) {
      const row = rows.get(live.source) ?? {
        source: live.source,
        lastCaptureAt: null,
        sessionCount: 0,
      };
      row.sessionCount += 1;
      if (live.updatedAt && (row.lastCaptureAt === null || live.updatedAt > row.lastCaptureAt)) {
        row.lastCaptureAt = live.updatedAt;
      }
      rows.set(live.source, row);
    }
    return SESSION_SOURCES.flatMap((source) => {
      const row = rows.get(source);
      return row ? [row] : [];
    });
  }

  async #status(): Promise<StatusResponse> {
    const pending = this.#retry.pending();
    const warnings: StatusResponse["warnings"] = [];
    if (this.#driveKnown && !this.#drive) {
      warnings.push({
        code: "AUTH_REQUIRED",
        message: "尚未登录 Google Drive，本地 API 可用，上传和同步会在登录后继续",
      });
    }
    if (this.#llmKnown && !this.#llm) {
      warnings.push(
        this.#llmWarning ?? {
          code: "LLM_NOT_CONFIGURED",
          message: "未配置模型，已上传会话但跳过提炼",
        },
      );
    } else if (isCliProvider(this.#shared.llm.provider)) {
      if (this.#cliPaused()) {
        const stalled = cliUnresponsiveWarning(this.#shared.llm.provider);
        if (stalled) warnings.push(stalled);
      } else {
        const denied = this.#retry
          .pending()
          .find((job) => job.kind === "auth" || job.reason.includes("未登录"));
        if (denied) {
          warnings.push(
            describeLlmSetupFailure(
              this.#shared.llm.provider,
              new LlmRequestError("auth", denied.reason),
            ),
          );
        }
      }
    }
    let search = { ready: false, documents: 0 };
    if (this.#search) {
      const status = this.#search.status();
      search = { ready: status.ready, documents: status.documents };
    }
    const consolidation = await this.#consolidation();
    if (consolidation.status === "stale") {
      warnings.push({ code: "CONSOLIDATION_STALE", message: "超过 1 天未沉淀" });
    }
    if (consolidation.enabled && this.#consolidationState.lastRun && !this.#consolidationState.lastRun.ok) {
      warnings.push({ code: "CONSOLIDATION_FAILED", message: "每日沉淀没有完成" });
    }
    const processor = resolveWebProcessor(this.#roles);
    const isLocalProcessor = processor !== null && processor === this.#local.deviceId;
    const indexed = this.#store ? listWebInbox(this.#store) : [];
    const sawWeb = this.#store?.getCursor(WEB_INBOX_SEEN_CURSOR) === "1";
    if ((indexed.length > 0 || sawWeb) && processor === null) {
      warnings.push({ code: "WEB_PROCESSOR_MISSING", message: "没有指定网页会话处理设备" });
    }
    const webPending =
      isLocalProcessor && this.#store
        ? countUnrefinedWebSessions(indexed, this.#store.listSessions())
        : 0;
    return {
      deviceId: this.#local.deviceId,
      drive: {
        reachable: this.#driveKnown ? (this.#drive ? this.#driveReachable : false) : null,
        accountEmail: this.#local.account.email || null,
      },
      sync: {
        lastSyncAt: this.#lastSyncAt,
        pendingOutbox: this.#store?.countOutbox() ?? 0,
        lastError: this.#lastSyncError?.message ?? null,
        lastErrorAt: this.#lastSyncError?.at ?? null,
      },
      search,
      refine: {
        pending: pending.length,
        lastError: pending[0]?.reason ?? null,
      },
      capture: { parsed: this.#lastScanParsed },
      captures: this.#captureRows(),
      upload: {
        pending: [...this.#live.values()].filter((live) => live.schedule.dirtySince !== null).length,
        slowestMs: this.#uploadSlowestMs,
        failures: this.#uploadFailures,
        lastError: this.#uploadLastError,
      },
      consolidation,
      web: {
        processor,
        isLocalProcessor,
        pending: webPending,
      },
      warnings,
      // 无界面登录时界面靠这个拿到授权链接；其余情况不出现。
      ...(this.#pendingAuthorization
        ? {
            login: {
              authorizationUrl: this.#pendingAuthorization.url,
              tunnel: this.#pendingAuthorization.tunnel,
            },
          }
        : {}),
    };
  }

  async #consolidate(options: { manual: boolean; force: boolean }) {
    const store = this.#store;
    const outcome = await executeConsolidation(
      {
        deviceId: this.#local.deviceId,
        mainDevice: this.#roles.mainDevice,
        enabled: this.#roles.consolidation.enabled,
        time: this.#roles.consolidation.time,
        timeZone: this.#roles.timezone,
        hasLlm: this.#llm !== null,
        hasDrive: this.#drive !== null,
        llm: this.#llm,
        activeLimit: this.#shared.topics.activeLimit,
        historyDays: this.#shared.topics.historyDays,
        clock: this.#clock,
        load: () => this.#consolidationView(),
        emit: (type, data) => this.#emitUser(type, data),
        cursors: {
          get: (key) => store?.getCursor(key) ?? null,
          set: (key, value) => {
            store?.setCursor(key, value);
          },
        },
        ...this.#portraitRuntime(),
        topicFiles: () => this.#writeTopicFiles(),
        readLease: async () => {
          if (!this.#drive) return null;
          return readConsolidateLease(this.#drive, (message) => {
            console.warn(message);
          });
        },
        writeLease: async (lease) => {
          if (!this.#drive) throw new Error("Drive 未打开");
          await writeConsolidateLease(this.#drive, lease);
        },
      },
      this.#consolidationState,
      options,
    );
    if (outcome.status === "rejected") throw new ConsolidationRejected(outcome.code);
    if (outcome.status === "done" && outcome.attempted) {
      const at = this.#clock.now().toISOString();
      this.changes.publish("topics", at);
      this.changes.publish("status", at);
    }
    if (outcome.status === "skipped") {
      return { day: outcome.day, ok: true, steps: [] };
    }
    return {
      day: outcome.result.day,
      ok: outcome.result.ok,
      steps: outcome.result.steps.map((step) =>
        step.error === undefined ? { id: step.id, ok: step.ok } : step,
      ),
    };
  }

  #portraitRuntime(): { portrait: ReturnType<typeof createDrivePortrait> } | Record<string, never> {
    const drive = this.#drive;
    const service = this.#portrait;
    const store = this.#store;
    if (!drive || !service || !store) return {};
    return {
      portrait: createDrivePortrait({
        drive,
        service,
        driveRoot: this.#local.driveRoot,
        config: () => ({
          variants: this.#shared.portrait.variants,
          snapshotPattern: this.#shared.portrait.snapshotPattern,
        }),
        events: () =>
          store.listEventsByType(["portrait.correction", "portrait.correction_applied"]),
        sessions: (day) => this.#twinSessions(day),
      }),
    };
  }

  /** The user's own turns for sessions last updated on or after `day`, oldest session first. */
  async #twinSessions(day: string): Promise<Array<{ sessionKey: string; title: string; turns: string[] }>> {
    const drive = this.#drive;
    const store = this.#store;
    if (!drive || !store) return [];
    const timeZone = this.#roles.timezone;
    // A 03:00 run would miss yesterday's evening without the extra day; the turn cursor skips repeats.
    const since = shiftDateKey(day, -1);
    const rows = store
      .listSessions()
      .filter(
        (session) =>
          session.fileId !== null &&
          session.updatedAt !== null &&
          localDayKey(new Date(session.updatedAt), timeZone) >= since,
      )
      .sort((left, right) => (left.updatedAt ?? "").localeCompare(right.updatedAt ?? ""));
    const sessions: Array<{ sessionKey: string; title: string; turns: string[] }> = [];
    for (const session of rows) {
      if (session.fileId === null) continue;
      const object = await drive.read(session.fileId).catch(() => null);
      const parsed = object ? parseWebSession(object.bytes.toString("utf8")) : null;
      if (!parsed) continue;
      sessions.push({
        sessionKey: session.sessionKey,
        title: session.title,
        turns: parsed.turns.filter((turn) => turn.role === "user").map((turn) => turn.text),
      });
    }
    return sessions;
  }

  #consolidationView() {
    const store = this.#store;
    const events = store?.listEvents() ?? [];
    const sessionUpdatedAt: Record<string, string> = {};
    for (const session of store?.listSessions() ?? []) {
      if (session.updatedAt !== null) sessionUpdatedAt[session.sessionKey] = session.updatedAt;
    }
    return { book: foldEvents(events), sessionUpdatedAt };
  }

  async #consolidation(): Promise<StatusResponse["consolidation"]> {
    if (!this.#roles.consolidation.enabled) {
      return { enabled: false, lastFinishedAt: null, stale: false, status: "disabled" };
    }
    const idle = this.#withLastRun({
      enabled: true,
      lastFinishedAt: null,
      stale: false,
      status: "ok" as const,
    });
    if (!this.#drive || !this.#driveKnown || !this.#driveReachable) return idle;
    try {
      const read = this.#drive.readPath(DRIVE_PATHS.consolidateLease).catch(() => null);
      const object = await Promise.race([
        read,
        delay(STATUS_DRIVE_WAIT_MS).then(() => undefined),
      ]);
      if (!object) return idle;
      const parsed = JSON.parse(object.bytes.toString("utf8")) as { finishedAt?: unknown };
      const finished = typeof parsed.finishedAt === "string" ? parsed.finishedAt : null;
      if (!finished) return idle;
      const ms = Date.parse(finished);
      const stale = Number.isNaN(ms) ? false : this.#clock.nowMs() - ms > INTERVALS.portraitMs;
      return this.#withLastRun({
        enabled: true,
        lastFinishedAt: finished,
        stale,
        status: stale ? "stale" : "ok",
      });
    } catch {
      return idle;
    }
  }

  #withLastRun<T extends StatusResponse["consolidation"]>(value: T): T {
    const lastRun = this.#consolidationState.lastRun;
    if (!lastRun) return value;
    return { ...value, lastRun };
  }

  #codingVariantPath(): string {
    return this.#shared.portrait.variants.find((variant) => variant.id === "coding")?.path ?? "";
  }

  async #ensureCoding(): Promise<void> {
    try {
      await this.#coding?.ensureApplied();
    } catch {
      // A corrupt consent file must not stop the daemon.
    }
  }

  #uploadIndex(): UploadIndex {
    return {
      fileIdOf: (key) => this.#store?.getSession(key)?.fileId ?? null,
      record: (key, fileId, meta) => {
        const live = this.#live.get(key);
        const existing = this.#store?.getSession(key);
        const source = existing?.source ?? live?.source;
        const device = existing?.device ?? live?.device;
        if (!source || !device || !this.#store) return;
        this.#store.upsertSession({
          sessionKey: key,
          source,
          device,
          startedAt: existing?.startedAt ?? live?.startedAt ?? meta.updatedAt,
          updatedAt: existing?.updatedAt ?? meta.updatedAt,
          fileId,
          msgCount: meta.messageCount,
        });
      },
    };
  }

  #rememberUpload(live: LiveSession, fileId: string, key: string): void {
    if (!this.#store) return;
    const existing = this.#store.getSession(key);
    this.#store.upsertSession({
      sessionKey: key,
      source: live.source,
      device: live.device,
      startedAt: existing?.startedAt ?? live.startedAt,
      updatedAt: live.updatedAt,
      fileId,
      msgCount: live.turnCount,
    });
  }

  #renderUpload(live: LiveSession, session: NormalizedSession) {
    const redacted = applyCaptureRedaction(session, {
      redact: this.#shared.capture.redact,
      redaction: {},
    });
    const rendered = renderSessionMarkdown(redacted.session, {
      redactionVersion: redacted.version,
      redactionCount: redacted.count,
      imageReferences: new Map(),
    });
    const stored = this.#store?.getSession(conversationKey(live.source, live.conversationId));
    return {
      source: live.source,
      conversationId: live.conversationId,
      device: live.device,
      ...(stored?.title ? { title: stored.title } : {}),
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      messageCount: session.turns.length,
      markdown: rendered.markdown,
      contentSha256: rendered.contentSha256,
    };
  }

  #previous(
    key: string,
    stored: { title: string; summary: string; refinedUpTo: number } | null,
  ): PreviousRefine | null {
    if (!stored || stored.refinedUpTo <= 0 || !this.#store) return null;
    return {
      title: stored.title,
      summary: stored.summary,
      conclusions: this.#store
        .listConclusions()
        .filter((item) => item.sessionKey === key)
        .map((item) => item.text),
      todos: this.#store
        .listTodos()
        .filter((item) => item.sessionKey === key)
        .map((item) => ({ id: item.todoId, text: item.text })),
    };
  }

  #candidateTopics(): CandidateTopic[] {
    if (!this.#store) return [];
    const book = foldEvents(this.#store.listEvents());
    const activity: Record<string, string> = {};
    for (const session of this.#store.listSessions()) {
      if (session.updatedAt) activity[session.sessionKey] = session.updatedAt;
    }
    const zones = partitionTopics(book, {
      now: this.#clock.now().toISOString(),
      activeLimit: this.#shared.topics.activeLimit,
      historyDays: this.#shared.topics.historyDays,
      sessionUpdatedAt: activity,
    });
    return [
      ...zones.active.map((topic) => ({
        topicId: topic.topicId,
        name: topic.name,
        aliases: topic.aliases,
        summary: topic.summary,
        zone: "active" as const,
      })),
      ...zones.history.map((topic) => ({
        topicId: topic.topicId,
        name: topic.name,
        aliases: topic.aliases,
        summary: topic.summary,
        zone: "history" as const,
        recency: Date.parse(topic.lastActive ?? "") || 0,
      })),
    ];
  }

  #openTodos(): OpenTodo[] {
    if (!this.#store) return [];
    return this.#store
      .listTodos()
      .filter((todo) => todo.status === "open")
      .map((todo) => ({
        todoId: todo.todoId,
        topicId: todo.topicId,
        text: todo.text,
      }));
  }

  #roots(): Record<SessionSource, string[]> {
    const roots = {
      "claude-code": [] as string[],
      codex: [] as string[],
      "grok-build": [] as string[],
      cursor: [] as string[],
      "gemini-cli": [] as string[],
      pi: [] as string[],
      "t3-code": [] as string[],
      zcode: [] as string[],
    };
    // 服务器上不存在这些 CLI 的会话目录。采集空转，只做提炼与沉淀。
    if (this.#local.role === "server") return roots;
    for (const id of SESSION_SOURCES) {
      if (this.#options.sourceRoots) {
        roots[id] = [...(this.#options.sourceRoots[id] ?? [])];
        continue;
      }
      const configured = this.#shared.capture.sources[id];
      if (!configured.enabled) continue;
      roots[id] =
        configured.paths.length > 0
          ? [...configured.paths]
          : [...(getAdapter(id)?.defaultRoots(this.#homeDir) ?? [])];
    }
    return roots;
  }

  #closeWatchers(): void {
    for (const watcher of this.#watchers) watcher.close();
    this.#watchers = [];
  }

  async #rewatch(): Promise<void> {
    this.#closeWatchers();
    if (!this.#watchEnabled || this.#stopped) return;
    for (const dirs of Object.values(this.#roots())) {
      if (this.#stopped) return;
      for (const dir of dirs) {
        if (this.#stopped) return;
        try {
          await access(dir);
        } catch {
          continue;
        }
        if (this.#stopped) return;
        try {
          const watcher = watch(dir, { recursive: true }, () => {
            this.#scheduleWatch();
          });
          watcher.on("error", () => undefined);
          if (this.#stopped) {
            watcher.close();
            return;
          }
          this.#watchers.push(watcher);
        } catch {
          // The directory can disappear between access and watch.
        }
      }
    }
  }

  #scheduleWatch(): void {
    if (this.#stopped) return;
    if (this.#watchTimer) clearTimeout(this.#watchTimer);
    this.#watchTimer = setTimeout(() => {
      this.#watchTimer = null;
      void this.scan();
    }, INTERVALS.watchDebounceMs);
  }

  #isIdle(live: LiveSession, now: number, idleMs: number): boolean {
    if (live.schedule.lastActivityAt === null) return false;
    return now - live.schedule.lastActivityAt >= idleMs;
  }

  #run<T>(fn: () => Promise<T>, kind: "work" | "shutdown" = "work"): Promise<T> {
    const invoke = (): Promise<T> | T => {
      if (this.#stopped && kind !== "shutdown") return undefined as T;
      return fn();
    };
    const run = this.#chain.then(invoke, invoke);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

const FLUSH_DEADLINE_MS = 3_000;

function latestActivity(values: readonly (string | null)[]): string {
  let best = Date.parse(ACTIVITY_EPOCH);
  for (const value of values) {
    if (value === null) continue;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) continue;
    if (ms > best) best = ms;
  }
  return new Date(best).toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function metaFrom(live: LiveSession): CaptureMeta {
  return {
    source: live.source,
    conversationId: live.conversationId,
    device: live.device,
    startedAt: live.startedAt,
    updatedAt: live.updatedAt,
    sourcePath: live.sourcePath,
    turnCount: live.turnCount,
    hash: live.hash,
    includeSubagents: live.includeSubagents,
    keepToolCalls: live.keepToolCalls,
    redact: live.redact,
  };
}

function assignMeta(live: LiveSession, meta: CaptureMeta): void {
  live.source = meta.source;
  live.conversationId = meta.conversationId;
  live.device = meta.device;
  live.startedAt = meta.startedAt;
  live.updatedAt = meta.updatedAt;
  live.sourcePath = meta.sourcePath;
  live.turnCount = meta.turnCount;
  live.hash = meta.hash;
  live.includeSubagents = meta.includeSubagents;
  live.keepToolCalls = meta.keepToolCalls;
  live.redact = meta.redact;
}

function asSearchDrive(drive: DrivePort): SearchDrive {
  return {
    changes: (query) => drive.changes(query),
    searchText: (query) => drive.searchText(query),
    async read(id: string) {
      const object = await drive.read(id);
      return { bytes: object.bytes };
    },
  };
}
