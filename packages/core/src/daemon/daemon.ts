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
import { getLlmApiKey } from "../auth/index.js";
import { applyCaptureRedaction } from "../capture/redact.js";
import { renderSessionMarkdown } from "../capture/normalize.js";
import {
  SESSION_SOURCES,
  YouBrainError,
  assertSupportedPlatform,
  loadLocalConfig,
  type LocalConfig,
  type NormalizedSession,
  type SessionSource,
  type YouBrainPaths,
} from "../domain/index.js";
import type { DriveEntry, DrivePort } from "../drive/drive-port.js";
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
  SearchRequest,
  StatusResponse,
  SyncActionResult,
  UploadActionInput,
  UploadActionResult,
  ZoneSettings,
} from "../http/types.js";
import { isCliNoOutputTimeout } from "../llm/cli/exec.js";
import {
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
  mergeSuggestionLines,
  parseMergeSuggestions,
  readConsolidateLease,
  writeConsolidateLease,
  MERGE_SUGGESTIONS_CURSOR,
  type ConsolidationState,
} from "../consolidate/index.js";
import { dueRemindersForDevice } from "../reminders/run.js";
import { timeZoneOffsetMinutes } from "../reminders/time.js";

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
import { describeSyncFailure } from "./sync-error.js";
import type { SecretStore } from "../auth/index.js";

const APP_VERSION = "0.1.0";
const BACKFILL_CURSOR = "capture.backfill";
/** A stuck Drive read must not hold `/api/status` longer than the shell's read timeout. */
const STATUS_DRIVE_WAIT_MS = 1_000;
/** Stop proceeds even if Drive or the model probe is still hanging. */
const BACKGROUND_STOP_MS = 3_000;

export interface DaemonOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  hostname?: string;
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
  secrets?: SecretStore;
  appVersion?: string;
  /** Default true. Tests set false so discovery is driven only by scan() and the 10 minute timer. */
  watch?: boolean;
  port?: number;
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
  #uploader: UploadService | null = null;
  #portrait: PortraitService | null = null;
  #coding: CodingInjection | null = null;
  #output: OutputService | null = null;
  #llm: LlmBackend | null = null;
  #llmWarning: LlmSetupWarning | null = null;
  #llmOverride: LlmBackend | null | undefined;
  /** Consecutive timeouts that produced no stdout and no stderr. */
  #cliSilentStreak = 0;
  /** Set after two silent timeouts. Cleared on config change or process restart. */
  #cliUnresponsive = false;
  #retry: LlmRetryQueue<string>;
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
  #lastReminders: number | null = null;
  #lastConsolidation: number | null = null;
  #consolidationState: ConsolidationState = emptyConsolidationState();
  /** Latest keyboard, pointer, or captured-session time. Not the heartbeat clock. */
  #lastActivityAt: string | null = null;
  /** Device-table activity from before this process wrote a row. */
  #preservedActivityAt: string | null = null;
  #preservedLoaded = false;
  #lastSyncAt: string | null = null;
  #lastSyncError: { message: string; at: string } | null = null;
  #searchDirty = false;
  #portraitSoon = false;
  /** Topic book changed while this device is allowed to publish topic files. */
  #topicFilesDirty = false;
  /** Epoch bumps on each change so an in-flight sync does not clear a newer edit. */
  #topicFilesEpoch = 0;
  #topicFilesQuietUntil: number | null = null;
  #topicFilesLock: Promise<void> = Promise.resolve();
  #scannedOnce = false;

  constructor(options: DaemonOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemDaemonClock();
    this.#homeDir = options.homeDir ?? homedir();
    this.#env = options.env ?? process.env;
    this.#appVersion = options.appVersion ?? APP_VERSION;
    this.#watchEnabled = options.watch !== false;
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
      }),
    );
    this.#local = loaded.config;
    this.#paths = loaded.paths;
    this.#configFile = loaded.configFile;
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
    this.#lastPortrait = startedAt;
    this.#lastSearch = startedAt;
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
        this.#sync = new ProtocolSync({
          drive: this.#drive,
          store: this.#store,
          device: this.#identity(),
          listener: {
            onTopicsChanged: () => {
              this.#onTopicsChanged();
            },
            onInboxChanged: (files) => this.#indexInbox(files),
            onDigitalTwinChanged: () => {
              this.#portraitSoon = true;
            },
            onConfigChanged: (update) => this.#onConfigChanged(update),
          },
          now: () => this.#clock.now(),
        });
        this.#uploader = new UploadService({
          drive: this.#drive,
          index: this.#uploadIndex(),
          deviceId: this.#local.deviceId,
          clock: { now: () => this.#clock.nowMs() },
        });
        this.#portrait = new PortraitService({
          drive: this.#drive,
          store: this.#store,
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
      } else {
        this.#driveReachable = false;
      }
    } catch (error) {
      this.#driveReachable = false;
      const message = error instanceof Error ? error.message : "failed";
      console.error(`startup: background ${message}`);
    } finally {
      this.#driveKnown = true;
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
    await this.#output?.whenIdle();
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stopBody();
    return this.#stopPromise;
  }

  async #stopBody(): Promise<void> {
    this.#stopped = true;
    this.#abort.abort();
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
        this.#store?.close();
        this.#store = null;
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

  async #runDue(): Promise<void> {
    if (this.#stopped) return;
    const now = this.#clock.nowMs();
    if (intervalDue(this.#lastFullScan, now, INTERVALS.fullScanMs)) {
      await this.#scanBody();
      this.#lastFullScan = this.#clock.nowMs();
    }
    await this.#processDue();
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
        await this.#sync.pull();
        this.#rememberSyncSuccess();
      } catch (error) {
        this.#rememberSyncFailure(error);
      }
      this.#restoreLocalActivity();
      this.#lastPull = this.#clock.nowMs();
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
    if (
      this.#search &&
      (this.#searchDirty || intervalDue(this.#lastSearch, now, INTERVALS.searchMs))
    ) {
      try {
        await this.#search.sync();
      } catch {
        // Keyword search keeps the last successful index.
      }
      this.#searchDirty = false;
      this.#lastSearch = this.#clock.nowMs();
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
  }

  async #processDue(options?: {
    forceIdle?: boolean;
    sources?: readonly string[];
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
    for (const [key, live] of sessions) {
      if (this.#stopped) return { scanned: sessions.length, uploaded };
      const decision = decideUpload(live.schedule, now, { idleMs, activeIntervalMs });
      if (!decision.due) {
        if (this.#isIdle(live, now, idleMs)) await this.#retryIfDue(key, live, now);
        continue;
      }
      try {
        const did = await this.#uploadOne(key, live, decision.reason === "idle");
        if (did) uploaded += 1;
      } catch {
        // Leave the session dirty so the next tick retries the upload.
      }
    }
    if (this.#store?.getCursor(BACKFILL_CURSOR) === "pending" && this.#scannedOnce) {
      this.#store.setCursor(BACKFILL_CURSOR, "done");
    }
    return { scanned: sessions.length, uploaded };
  }

  async #uploadOne(key: string, live: LiveSession, refine: boolean): Promise<boolean> {
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
    this.#searchDirty = true;
    const now = this.#clock.nowMs();
    const current = this.#live.get(key) ?? live;
    // An active upload refreshes the bytes but leaves the session dirty so the
    // later idle pass still refines. Only the idle upload clears that debt.
    if (refine) {
      current.schedule =
        current.hash === before
          ? noteUpload(current.schedule, now)
          : noteActivity(noteUpload(current.schedule, now), now);
      await this.#refine(key, current, result.fileId, session);
    } else {
      current.schedule = {
        lastActivityAt: current.hash === before ? current.schedule.lastActivityAt : now,
        lastUploadAt: now,
        dirtySince: current.hash === before ? (current.schedule.dirtySince ?? now) : now,
      };
    }
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
    const stored = this.#store.getSession(key);
    const refinedUpTo = stored?.refinedUpTo ?? 0;
    const messages = session.turns.slice(refinedUpTo).map((turn) => ({
      role: turn.role,
      text: turn.text,
    }));
    if (messages.length === 0) {
      this.#retry.succeed(key);
      return;
    }
    if (this.#cliUnresponsive) return;
    try {
      const result = await refineSession(
        this.#llm,
        {
          sessionKey: key,
          fileId,
          source: live.source,
          refinedUpTo,
          messages,
          previous: this.#previous(key, stored),
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
        if (result.reason === "no_new_messages") this.#retry.succeed(key);
        else this.#retry.fail(key, key, new Error(result.detail));
        return;
      }
      for (const event of result.events) await this.#emitCopied(event);
      this.#cliSilentStreak = 0;
      this.#retry.succeed(key);
    } catch (error) {
      if (isCliNoOutputTimeout(error)) this.#cliSilentStreak += 1;
      else this.#cliSilentStreak = 0;
      if (this.#cliSilentStreak >= 2) this.#cliUnresponsive = true;
      this.#retry.fail(key, key, error);
      this.changes.publish("status", this.#clock.now().toISOString());
    }
  }

  async #retryIfDue(key: string, live: LiveSession, now: number): Promise<void> {
    if (this.#cliUnresponsive) return;
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
      this.#files.set(hit.path, { stamp: hit.stamp, key: hit.key, generation });
    }
    for (const path of this.#files.keys()) {
      if (!visited.has(path)) this.#files.delete(path);
    }
    this.#scannedOnce = true;
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

  async #indexInbox(files: readonly DriveEntry[]): Promise<void> {
    if (!this.#drive || !this.#store) return;
    for (const file of files) {
      if (!file.path.startsWith("inbox/") || !file.path.endsWith(".md")) continue;
      try {
        const object = await this.#drive.read(file.id);
        const fields = frontmatter(object.bytes.toString("utf8"));
        const source = fields.get("source");
        const conversationId = fields.get("conversation_id");
        const startedAt = fields.get("started_at");
        const updatedAt = fields.get("updated_at");
        if (!source || !conversationId || !startedAt || !updatedAt) continue;
        const turnCount = Number(fields.get("turn_count") ?? "0");
        this.#store.upsertSession({
          sessionKey: conversationKey(source, conversationId),
          source,
          device: fields.get("device") || this.#local.displayName,
          startedAt,
          updatedAt,
          fileId: file.id,
          msgCount: Number.isInteger(turnCount) && turnCount >= 0 ? turnCount : 0,
        });
      } catch {
        // Skip a malformed inbox file and keep pulling.
      }
    }
    this.#output?.schedule();
    this.changes.publish("today", this.#clock.now().toISOString());
  }

  async #emitCopied(event: Event): Promise<void> {
    if (this.#sync) {
      await appendCopied(this.#sync, event);
      return;
    }
    if (!this.#log || !this.#store) return;
    const allocated = allocateCopied(this.#log, event);
    this.#enqueueLocal(allocated);
    persistTopicBook(this.#store, applyEvents(foldEvents(this.#store.listEvents()), [allocated]));
    this.#onTopicsChanged();
  }

  async #emitUser<T extends EventType>(type: T, data: EventOf<T>["data"]): Promise<void> {
    if (this.#sync) {
      await this.#sync.append(type, data);
      return;
    }
    if (!this.#log || !this.#store) return;
    const event = this.#log.allocate(type, data);
    this.#enqueueLocal(event);
    persistTopicBook(this.#store, applyEvents(foldEvents(this.#store.listEvents()), [event]));
    this.#onTopicsChanged();
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

  async #onConfigChanged(update: {
    shared?: SharedConfig;
    roles?: Roles;
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
      this.#roles = update.roles;
      await writeJsonFile(join(this.#paths.dataDir, "roles.json"), this.#roles);
      this.#applyZone();
      this.#mountOutput();
    }
    this.changes.publish("status", this.#clock.now().toISOString());
  }

  async #heartbeat(): Promise<void> {
    if (this.#sync) {
      try {
        await this.#sync.heartbeat({ lastActiveAt: this.#activityForDevice() });
        this.#driveReachable = true;
      } catch {
        this.#driveReachable = false;
      }
    }
    this.#rememberDevice();
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

  #rememberDevice(): void {
    if (!this.#store) return;
    const now = this.#clock.now().toISOString();
    this.#store.upsertDevice({
      deviceId: this.#local.deviceId,
      displayName: this.#local.displayName,
      kind: "desktop",
      platform: this.#platform,
      appVersion: this.#appVersion,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: ["capture", "refine"],
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
      kind: "desktop",
      platform: this.#platform,
      appVersion: this.#appVersion,
      capabilities: ["capture", "refine"],
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
        getApiKey: (provider) => getLlmApiKey(provider, { platform: this.#platform }),
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
      readRoles: async () => this.#roles,
      writeRoles: (roles) => this.#writeRoles(roles),
      readConfig: async () => this.#shared,
      writeConfig: (config) => this.#writeConfig(config),
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
    if (this.#sync) await this.#sync.updateRoles(roles);
    this.changes.publish("status", this.#clock.now().toISOString());
  }

  #clearCliStall(): void {
    this.#cliSilentStreak = 0;
    this.#cliUnresponsive = false;
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
    if (this.#sync) await this.#sync.updateShared(config);
    this.changes.publish("status", this.#clock.now().toISOString());
  }

  async #syncNow(): Promise<SyncActionResult> {
    const at = this.#clock.now().toISOString();
    if (!this.#sync) return { started: false, at };
    await this.#run(async () => {
      try {
        await this.#sync?.pull();
        this.#rememberSyncSuccess();
        this.#lastPull = this.#clock.nowMs();
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
      if (this.#cliUnresponsive) {
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
      consolidation,
      warnings,
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
      }),
    };
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
    };
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

function frontmatter(markdown: string): Map<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(markdown);
  const fields = new Map<string, string>();
  for (const line of match?.[1]?.split("\n") ?? []) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    fields.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return fields;
}

function asSearchDrive(drive: DrivePort): SearchDrive {
  return {
    changes: (query) => drive.changes(query),
    async read(id: string) {
      const object = await drive.read(id);
      return { bytes: object.bytes };
    },
  };
}
