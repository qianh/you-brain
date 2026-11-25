import { randomUUID } from "node:crypto";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type RTCDataChannel,
  type RTCIceServer,
} from "werift";

import type {
  IceServerEntry,
  RdCloseArgs,
  RdIceArgs,
  RdIceCandidate,
  RdOpenArgs,
  RdOpenResult,
  RdQuality,
} from "@you-brain/protocol";

import { LossBasedBitrateController } from "./bitrate.js";
import { HostFileTransfer, type FileChannelPort } from "./file-transfer.js";
import { MacOsRemoteDesktopBridge, type RemoteDesktopHostBridge } from "./host-macos.js";
import { LowLatencyH264RtpStreamer } from "./rtp-h264.js";
import {
  CLIPBOARD_CHUNK_CHARS,
  CLIPBOARD_MAX_CHARS,
  DEFAULT_CLIENT_ICE_SERVERS,
  QUALITY_PRESETS,
  type ControlClientMessage,
  type ControlServerMessage,
  type FastInputMessage,
  type HostClipboardEvent,
  type HostCursorShape,
  type HostStateSnapshot,
  type HostStreamOptions,
  type RemoteDesktopSignalingEvents,
} from "./types.js";

const MAX_SESSIONS = 2;
const SESSION_IDLE_TIMEOUT_MS = 10 * 60_000;
const ICE_BATCH_FLUSH_MS = 15;
const MAX_ICE_BATCH = 32;
const STATS_INTERVAL_MS = 2_000;
const FILE_DRAIN_LOW_WATER = 1024 * 1024;
const MAX_DOWNLOAD_ALLOW = 200;

export interface RemoteDesktopPort {
  readonly supported: boolean;
  warmup?(): void;
  setSignalingEvents(events: RemoteDesktopSignalingEvents | null): void;
  /** `iceServers` 由调用方预先解析（宿主子进程场景）；缺省时由实现自行获取。 */
  openSession(fromDeviceId: string, args: RdOpenArgs, iceServers?: IceServerEntry[]): Promise<RdOpenResult>;
  addIceCandidates(fromDeviceId: string, args: RdIceArgs): Promise<{ ok: true }>;
  closeSession(fromDeviceId: string, args: RdCloseArgs): Promise<{ ok: true }>;
  closeAll(reason?: string): Promise<void>;
}

interface ActiveRdSession {
  readonly sessionId: string;
  readonly peerDeviceId: string;
  readonly pc: RTCPeerConnection;
  readonly streamer: LowLatencyH264RtpStreamer;
  controlDc: RTCDataChannel | null;
  quality: RdQuality;
  displayId: number | undefined;
  lastActiveAt: number;
  closed: boolean;
  iceQueue: RdIceCandidate[];
  iceFlushTimer: ReturnType<typeof setTimeout> | null;
  /** 控制端本地渲染光标（光标不进画面）。 */
  localCursor: boolean;
  /** 控制端开启双向剪贴板自动同步。 */
  clipboardSync: boolean;
  fileTransfer: HostFileTransfer | null;
  /** 远端剪贴板通告过、允许控制端下载的文件路径。 */
  allowedDownloads: Set<string>;
  bitrate: LossBasedBitrateController;
  statsTimer: ReturnType<typeof setInterval> | null;
  clipboardInbound: { id: string; n: number; parts: string[]; received: number; chars: number } | null;
}

function chunkId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function fileChannelPort(dc: RTCDataChannel): FileChannelPort {
  return {
    send: (data) => dc.send(data),
    get bufferedAmount() {
      return dc.bufferedAmount;
    },
    get isOpen() {
      return dc.readyState === "open";
    },
    waitDrain: async () => {
      while (dc.readyState === "open" && dc.bufferedAmount > FILE_DRAIN_LOW_WATER) {
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    },
  };
}

function toWeriftIceServers(entries: IceServerEntry[]): RTCIceServer[] {
  return entries.map((entry) => ({
    urls: entry.urls,
    ...(entry.username !== undefined ? { username: entry.username } : {}),
    ...(entry.credential !== undefined ? { credential: entry.credential } : {}),
  }));
}

function buildH264Codecs(): RTCRtpCodecParameters[] {
  const feedback = [
    { type: "nack" },
    { type: "nack", parameter: "pli" },
    { type: "ccm", parameter: "fir" },
  ];
  return [
    new RTCRtpCodecParameters({
      mimeType: "video/H264",
      clockRate: 90_000,
      parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
      rtcpFeedback: feedback,
    }),
    new RTCRtpCodecParameters({
      mimeType: "video/H264",
      clockRate: 90_000,
      parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
      rtcpFeedback: feedback,
    }),
  ];
}

function isValidQuality(value: unknown): value is RdQuality {
  return value === "smooth" || value === "hd" || value === "ultra";
}

export interface RemoteDesktopHostManagerOptions {
  supported?: boolean;
  bridge?: RemoteDesktopHostBridge;
  getIceServers?: () => Promise<IceServerEntry[]> | IceServerEntry[];
  helperIdleGraceMs?: number;
  iceStunGatherTimeoutSec?: number;
}

export class RemoteDesktopHostManager implements RemoteDesktopPort {
  readonly supported: boolean;
  readonly #bridge: RemoteDesktopHostBridge | null;
  readonly #getIceServers: () => Promise<IceServerEntry[]> | IceServerEntry[];
  readonly #helperIdleGraceMs: number;
  readonly #iceStunGatherTimeoutSec: number;
  readonly #sessions = new Map<string, ActiveRdSession>();
  #events: RemoteDesktopSignalingEvents | null = null;
  #idleTimer: ReturnType<typeof setInterval> | null = null;
  #helperStopTimer: ReturnType<typeof setTimeout> | null = null;
  #unsubVideo: (() => void) | null = null;
  #unsubState: (() => void) | null = null;
  #unsubClipboard: (() => void) | null = null;
  #unsubError: (() => void) | null = null;
  #unsubCursor: (() => void) | null = null;
  #latestClipboardRecipient: ActiveRdSession | null = null;
  #clipboardImageSeq = 0;
  #lastCursor: HostCursorShape | null = null;
  #appliedStreamOptions: string | null = null;
  #appliedBitrate: number | null = null;

  constructor(options?: RemoteDesktopHostManagerOptions) {
    this.supported = options?.supported ?? process.platform === "darwin";
    this.#bridge =
      options?.bridge ?? (this.supported ? new MacOsRemoteDesktopBridge() : null);
    this.#getIceServers = options?.getIceServers ?? (() => DEFAULT_CLIENT_ICE_SERVERS);
    this.#helperIdleGraceMs = options?.helperIdleGraceMs ?? 2_000;
    this.#iceStunGatherTimeoutSec = options?.iceStunGatherTimeoutSec ?? 1.5;

    if (this.#bridge) {
      this.#bindBridge(this.#bridge);
    }
  }

  setSignalingEvents(events: RemoteDesktopSignalingEvents | null): void {
    this.#events = events;
  }

  warmup(): void {
    if (!this.supported || !this.#bridge?.warmup) return;
    void this.#bridge.warmup().catch(() => {});
  }

  async openSession(
    fromDeviceId: string,
    args: RdOpenArgs,
    overrideIceServers?: IceServerEntry[],
  ): Promise<RdOpenResult> {
    if (!this.supported || !this.#bridge) {
      throw new Error("当前设备不支持远程桌面宿主");
    }

    const sessionId = args.sessionId ?? `rd-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const existing = this.#sessions.get(sessionId);
    if (existing) {
      await this.#disposeSession(existing, false);
    }

    while (this.#sessions.size >= MAX_SESSIONS) {
      let oldest: ActiveRdSession | null = null;
      for (const item of this.#sessions.values()) {
        if (!oldest || item.lastActiveAt < oldest.lastActiveAt) {
          oldest = item;
        }
      }
      if (!oldest) break;
      await this.#disposeSession(oldest, true, "新远程桌面会话已抢占连接");
    }

    if (this.#helperStopTimer) {
      clearTimeout(this.#helperStopTimer);
      this.#helperStopTimer = null;
    }

    const quality: RdQuality = args.quality ?? "hd";
    const [snapshot, iceEntries] = await Promise.all([
      this.#bridge.ensureStarted({
        quality,
        ...(args.displayId !== undefined ? { displayId: args.displayId } : {}),
        promptPermissions: false,
      }),
      overrideIceServers
        ? Promise.resolve(overrideIceServers)
        : Promise.resolve()
            .then(() => this.#getIceServers())
            .catch(() => DEFAULT_CLIENT_ICE_SERVERS),
    ]);
    // 新开流以预设码率起步；自适应控制器随后按丢包调整。
    this.#appliedBitrate = null;

    const hasIceServers = iceEntries.length > 0;
    const pc = new RTCPeerConnection({
      iceServers: toWeriftIceServers(iceEntries),
      iceUseDefaultStunServer: false,
      ...(!hasIceServers ? { iceAdditionalHostAddresses: ["127.0.0.1"] } : {}),
      iceStunGatherTimeout: this.#iceStunGatherTimeoutSec,
      codecs: { video: buildH264Codecs() },
      pendingRtp: { enabled: true, maxLength: 96 },
    });

    const videoTrack = new MediaStreamTrack({ kind: "video", streamId: "ubrain-rd" });
    const transceiver = pc.addTransceiver(videoTrack, { direction: "sendonly" });
    const sender = transceiver.sender;

    const streamer = new LowLatencyH264RtpStreamer(
      {
        get ssrc() {
          return sender.ssrc;
        },
        get payloadType() {
          return sender.codec?.payloadType ?? 96;
        },
        sendRtp(packet) {
          return sender.sendRtp(packet);
        },
      },
      {
        onDropNeedKeyframe: () => {
          this.#bridge?.requestKeyframe();
        },
      },
    );

    const session: ActiveRdSession = {
      sessionId,
      peerDeviceId: fromDeviceId,
      pc,
      streamer,
      controlDc: null,
      quality,
      displayId: snapshot.activeDisplayId,
      lastActiveAt: Date.now(),
      closed: false,
      iceQueue: [],
      iceFlushTimer: null,
      localCursor: false,
      clipboardSync: false,
      fileTransfer: null,
      allowedDownloads: new Set(),
      bitrate: new LossBasedBitrateController({
        maxBps: QUALITY_PRESETS[quality].bitrateBps,
        onChange: () => this.#applyBitrate(),
      }),
      statsTimer: null,
      clipboardInbound: null,
    };

    sender.onRtcp.subscribe((packet) => {
      if (session.closed) return;
      const reports = (packet as { reports?: Array<{ ssrc: number; fractionLost: number }> }).reports;
      if (!Array.isArray(reports)) return;
      for (const report of reports) {
        if (report.ssrc === sender.ssrc) {
          session.bitrate.onReceiverReport(report.fractionLost, Date.now());
        }
      }
    });

    sender.onKeyFrameRequest.subscribe(() => {
      if (!session.closed) {
        this.#bridge?.requestKeyframe();
      }
    });

    pc.onIceCandidate.subscribe((candidate) => {
      if (session.closed || !candidate || !candidate.candidate) return;
      this.#enqueueLocalCandidate(session, {
        candidate: candidate.candidate,
        ...(candidate.sdpMid !== undefined ? { sdpMid: candidate.sdpMid } : {}),
        ...(candidate.sdpMLineIndex !== undefined ? { sdpMLineIndex: candidate.sdpMLineIndex } : {}),
        ...(candidate.usernameFragment !== undefined
          ? { usernameFragment: candidate.usernameFragment }
          : {}),
      });
    });

    pc.connectionStateChange.subscribe((state) => {
      if (session.closed) return;
      if (state === "connected") {
        session.lastActiveAt = Date.now();
        this.#startStats(session);
        this.#bridge?.requestKeyframe();
        const cur = this.#bridge?.getStateSnapshot() ?? snapshot;
        this.#events?.onState(session.peerDeviceId, session.sessionId, {
          state: "ready",
          displays: cur.displays,
          activeDisplayId: cur.activeDisplayId,
          permissions: cur.permissions,
        });
      } else if (state === "failed" || state === "closed") {
        void this.#disposeSession(session, true);
      }
    });

    pc.onDataChannel.subscribe((dc) => {
      if (session.closed) return;
      this.#attachDataChannel(session, dc);
    });

    try {
      await pc.setRemoteDescription({ type: "offer", sdp: args.offerSdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const answerSdp = pc.localDescription?.sdp ?? answer.sdp;
      this.#sessions.set(session.sessionId, session);
      this.#applyStreamOptions();
      this.#ensureIdleSweep();
      this.#bridge.requestKeyframe();
      return {
        sessionId: session.sessionId,
        answerSdp,
        displays: snapshot.displays,
        activeDisplayId: snapshot.activeDisplayId,
        permissions: snapshot.permissions,
      };
    } catch (error) {
      streamer.close();
      await pc.close().catch(() => {});
      this.#scheduleHelperStopIfIdle();
      throw error;
    }
  }

  async addIceCandidates(fromDeviceId: string, args: RdIceArgs): Promise<{ ok: true }> {
    const session = this.#sessions.get(args.sessionId);
    if (!session || session.closed) {
      return { ok: true };
    }
    if (session.peerDeviceId !== fromDeviceId) {
      throw new Error("无权操作其他设备的远程桌面会话");
    }
    session.lastActiveAt = Date.now();
    for (const item of args.candidates) {
      if (!item.candidate) {
        await session.pc.addIceCandidate(null).catch(() => {});
        continue;
      }
      await session.pc
        .addIceCandidate({
          candidate: item.candidate,
          sdpMid: item.sdpMid ?? null,
          sdpMLineIndex: item.sdpMLineIndex ?? null,
          usernameFragment: item.usernameFragment ?? null,
        })
        .catch(() => {});
    }
    return { ok: true };
  }

  async closeSession(fromDeviceId: string, args: RdCloseArgs): Promise<{ ok: true }> {
    const session = this.#sessions.get(args.sessionId);
    if (!session) return { ok: true };
    if (session.peerDeviceId !== fromDeviceId) {
      throw new Error("无权关闭其他设备的远程桌面会话");
    }
    await this.#disposeSession(session, false);
    return { ok: true };
  }

  async closeAll(reason?: string): Promise<void> {
    if (this.#idleTimer) {
      clearInterval(this.#idleTimer);
      this.#idleTimer = null;
    }
    if (this.#helperStopTimer) {
      clearTimeout(this.#helperStopTimer);
      this.#helperStopTimer = null;
    }
    const active = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const session of active) {
      await this.#disposeSession(session, Boolean(reason), reason);
    }
    this.#appliedStreamOptions = null;
    this.#appliedBitrate = null;
    this.#lastCursor = null;
    if (this.#bridge) {
      this.#bridge.releaseInputs();
      await this.#bridge.close().catch(() => {});
    }
  }

  #bindBridge(bridge: RemoteDesktopHostBridge): void {
    this.#unsubVideo = bridge.subscribeVideo((frame) => {
      for (const session of this.#sessions.values()) {
        if (!session.closed) {
          session.streamer.enqueue(frame);
        }
      }
    });

    this.#unsubState = bridge.subscribeState((state) => {
      for (const session of this.#sessions.values()) {
        if (session.closed) continue;
        session.displayId = state.activeDisplayId;
        this.#sendControlMessage(session, this.#stateMessage(session, state));
        this.#events?.onState(session.peerDeviceId, session.sessionId, {
          state: "ready",
          displays: state.displays,
          activeDisplayId: state.activeDisplayId,
          permissions: state.permissions,
        });
      }
    });

    this.#unsubClipboard = bridge.subscribeClipboard((text, meta) => {
      this.#onHostClipboard(text, meta);
    });

    this.#unsubCursor =
      bridge.subscribeCursor?.((cursor) => {
        this.#lastCursor = cursor;
        for (const session of this.#sessions.values()) {
          if (!session.closed && session.localCursor) {
            this.#sendControlMessage(session, { t: "cursor", ...cursor });
          }
        }
      }) ?? null;

    this.#unsubError = bridge.subscribeError((message) => {
      for (const session of this.#sessions.values()) {
        if (session.closed) continue;
        this.#events?.onState(session.peerDeviceId, session.sessionId, {
          state: "error",
          error: message,
        });
      }
    });
  }

  #attachDataChannel(session: ActiveRdSession, dc: RTCDataChannel): void {
    if (dc.label === "input-fast") {
      dc.onMessage.subscribe((raw) => {
        if (session.closed) return;
        session.lastActiveAt = Date.now();
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        try {
          const msg = JSON.parse(text) as FastInputMessage;
          if (msg && (msg.t === "mm" || msg.t === "wh")) {
            this.#bridge?.handleFastInput(msg);
          }
        } catch {
          // 忽略异常输入帧
        }
      });
      return;
    }

    if (dc.label === "file") {
      const transfer = new HostFileTransfer(fileChannelPort(dc), {
        isDownloadAllowed: (path) => session.allowedDownloads.has(path),
        readClipboardImage: async () => (await this.#bridge?.readClipboardImage?.()) ?? null,
        writeClipboardImage: (data) => {
          if (!this.#bridge?.writeClipboardImage) throw new Error("远端不支持写入剪贴板图片");
          this.#bridge.writeClipboardImage(data.toString("base64"));
        },
      });
      void session.fileTransfer?.dispose();
      session.fileTransfer = transfer;
      dc.onMessage.subscribe((raw) => {
        if (session.closed) return;
        session.lastActiveAt = Date.now();
        transfer.handleMessage(raw);
      });
      dc.stateChanged.subscribe((st) => {
        if (st === "closed" && session.fileTransfer === transfer) {
          session.fileTransfer = null;
          void transfer.dispose();
        }
      });
      return;
    }

    if (dc.label === "control") {
      session.controlDc = dc;
      const sendInitialState = () => {
        if (session.closed || !this.#bridge) return;
        const snap: HostStateSnapshot = this.#bridge.getStateSnapshot();
        this.#sendControlMessage(session, this.#stateMessage(session, snap));
        this.#bridge.requestKeyframe();
      };
      if (dc.readyState === "open") {
        sendInitialState();
      } else {
        dc.stateChanged.subscribe((st) => {
          if (st === "open") sendInitialState();
        });
      }

      dc.onMessage.subscribe((raw) => {
        if (session.closed) return;
        session.lastActiveAt = Date.now();
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        let msg: ControlClientMessage;
        try {
          msg = JSON.parse(text) as ControlClientMessage;
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return;

        switch (msg.t) {
          case "ping":
            if (typeof msg.ts === "number") {
              this.#sendControlMessage(session, { t: "pong", ts: msg.ts });
            }
            return;
          case "disp":
            if (typeof msg.displayId === "number" && msg.displayId >= 0) {
              session.displayId = Math.trunc(msg.displayId);
              void this.#reconfigureBridge(session);
            }
            return;
          case "qual":
            if (isValidQuality(msg.quality) && msg.quality in QUALITY_PRESETS) {
              session.quality = msg.quality;
              session.bitrate.setMax(QUALITY_PRESETS[msg.quality].bitrateBps);
              void this.#reconfigureBridge(session);
            }
            return;
          case "cfg":
            session.localCursor = msg.localCursor === true;
            session.clipboardSync = msg.clipboardSync === true;
            this.#applyStreamOptions();
            if (session.localCursor) {
              if (this.#lastCursor) {
                this.#sendControlMessage(session, { t: "cursor", ...this.#lastCursor });
              } else {
                this.#bridge?.requestCursor?.();
              }
            }
            return;
          case "cb.get":
            this.#latestClipboardRecipient = session;
            this.#bridge?.handleControlInput(msg);
            return;
          case "cb.set":
            this.#onClientClipboard(session, msg);
            return;
          default:
            this.#bridge?.handleControlInput(msg);
            return;
        }
      });
    }
  }

  async #reconfigureBridge(session: ActiveRdSession): Promise<void> {
    if (!this.#bridge || session.closed) return;
    try {
      const snap = await this.#bridge.configure({
        quality: session.quality,
        ...(session.displayId !== undefined ? { displayId: session.displayId } : {}),
      });
      // 重新配置会把编码码率重置为预设值，之后需重新下发自适应码率。
      this.#appliedBitrate = null;
      this.#applyBitrate();
      if (!session.closed) {
        this.#sendControlMessage(session, this.#stateMessage(session, snap));
        this.#bridge.requestKeyframe();
      }
    } catch {
      // ignore transient reconfigure error
    }
  }

  #stateMessage(session: ActiveRdSession, snap: HostStateSnapshot): ControlServerMessage {
    return {
      t: "state",
      displays: snap.displays,
      activeDisplayId: snap.activeDisplayId,
      permissions: snap.permissions,
      quality: session.quality,
      ...(snap.doubleClickMs !== undefined ? { doubleClickMs: snap.doubleClickMs } : {}),
    };
  }

  /** 宿主剪贴板变化：主动拉取的结果只回给请求方；监听到的变化推给开了自动同步的会话。 */
  #onHostClipboard(text: string, meta?: HostClipboardEvent): void {
    const live = [...this.#sessions.values()].filter((item) => !item.closed);
    let targets: ActiveRdSession[];
    if (meta?.auto) {
      targets = live.filter((item) => item.clipboardSync);
    } else {
      const target = this.#latestClipboardRecipient;
      targets = target && !target.closed ? [target] : live;
    }
    const imageId = meta?.image && !text ? `img${++this.#clipboardImageSeq}` : "";
    for (const session of targets) {
      if (meta?.files && meta.files.length > 0) {
        for (const file of meta.files) {
          session.allowedDownloads.add(file.path);
        }
        while (session.allowedDownloads.size > MAX_DOWNLOAD_ALLOW) {
          const first = session.allowedDownloads.values().next().value;
          if (first === undefined) break;
          session.allowedDownloads.delete(first);
        }
        this.#sendControlMessage(session, { t: "cb.files", files: meta.files });
      }
      if (meta?.image && imageId) {
        this.#sendControlMessage(session, {
          t: "cb.image",
          id: imageId,
          w: meta.image.w,
          h: meta.image.h,
          ...(meta.auto ? { auto: true } : {}),
        });
        continue;
      }
      if (text || !meta?.files?.length) {
        this.#sendClipboardText(session, text, Boolean(meta?.auto));
      }
    }
  }

  #sendClipboardText(session: ActiveRdSession, text: string, auto: boolean): void {
    const clipped = text.length > CLIPBOARD_MAX_CHARS ? text.slice(0, CLIPBOARD_MAX_CHARS) : text;
    if (clipped.length <= CLIPBOARD_CHUNK_CHARS) {
      this.#sendControlMessage(session, { t: "cb", text: clipped, ...(auto ? { auto: true } : {}) });
      return;
    }
    const id = chunkId();
    const n = Math.ceil(clipped.length / CLIPBOARD_CHUNK_CHARS);
    for (let i = 0; i < n; i += 1) {
      this.#sendControlMessage(session, {
        t: "cb",
        text: clipped.slice(i * CLIPBOARD_CHUNK_CHARS, (i + 1) * CLIPBOARD_CHUNK_CHARS),
        ...(auto ? { auto: true } : {}),
        chunk: { id, i, n },
      });
    }
  }

  /** 控制端写剪贴板：支持分片重组；写入后同步给其他开了自动同步的会话。 */
  #onClientClipboard(session: ActiveRdSession, msg: Extract<ControlClientMessage, { t: "cb.set" }>): void {
    if (typeof msg.text !== "string") return;
    let full: string | null = null;
    const chunk = msg.chunk;
    if (!chunk) {
      session.clipboardInbound = null;
      full = msg.text;
    } else {
      const n = Math.trunc(chunk.n);
      const i = Math.trunc(chunk.i);
      if (!(n >= 1 && n <= Math.ceil(CLIPBOARD_MAX_CHARS / 1_000) && i >= 0 && i < n)) return;
      let inbound = session.clipboardInbound;
      if (!inbound || inbound.id !== chunk.id || inbound.n !== n) {
        inbound = { id: String(chunk.id), n, parts: new Array<string>(n), received: 0, chars: 0 };
        session.clipboardInbound = inbound;
      }
      if (inbound.parts[i] === undefined) {
        inbound.parts[i] = msg.text;
        inbound.received += 1;
        inbound.chars += msg.text.length;
      }
      if (inbound.chars > CLIPBOARD_MAX_CHARS) {
        session.clipboardInbound = null;
        return;
      }
      if (inbound.received < n) return;
      session.clipboardInbound = null;
      full = inbound.parts.join("");
    }
    this.#bridge?.handleControlInput({ t: "cb.set", text: full });
    for (const other of this.#sessions.values()) {
      if (other !== session && !other.closed && other.clipboardSync) {
        this.#sendClipboardText(other, full, true);
      }
    }
  }

  /** 汇总所有会话的能力声明下发给助手：全部会话都本地渲染光标时，光标才不进画面。 */
  #applyStreamOptions(): void {
    if (!this.#bridge?.setStreamOptions) return;
    const live = [...this.#sessions.values()].filter((item) => !item.closed);
    const options: HostStreamOptions = {
      showCursorInVideo: live.length === 0 || live.some((item) => !item.localCursor),
      cursorShape: live.some((item) => item.localCursor),
      clipboardWatch: live.some((item) => item.clipboardSync),
    };
    const key = JSON.stringify(options);
    if (key === this.#appliedStreamOptions) return;
    this.#appliedStreamOptions = key;
    this.#bridge.setStreamOptions(options);
  }

  /** 多会话共用一路编码，取各会话自适应码率的最小值。 */
  #applyBitrate(): void {
    if (!this.#bridge?.setBitrate) return;
    let target = Number.POSITIVE_INFINITY;
    for (const session of this.#sessions.values()) {
      if (!session.closed) target = Math.min(target, session.bitrate.targetBps);
    }
    if (!Number.isFinite(target)) return;
    if (this.#appliedBitrate === null) {
      // 编码器此时为预设码率；目标与预设一致时无需下发。
      const presetMax = Math.min(
        ...[...this.#sessions.values()].filter((item) => !item.closed).map((item) => item.bitrate.maxBps),
      );
      this.#appliedBitrate = presetMax;
    }
    if (Math.abs(target - this.#appliedBitrate) / Math.max(1, this.#appliedBitrate) < 0.02) return;
    this.#appliedBitrate = target;
    this.#bridge.setBitrate(target);
  }

  #startStats(session: ActiveRdSession): void {
    if (session.statsTimer) return;
    session.statsTimer = setInterval(() => {
      if (session.closed) return;
      this.#sendControlMessage(session, {
        t: "stats",
        bitrateBps: this.#appliedBitrate ?? session.bitrate.targetBps,
        lossPct: Math.round(session.bitrate.lastLoss * 1000) / 10,
        rttMs: null,
      });
    }, STATS_INTERVAL_MS);
    session.statsTimer.unref?.();
  }

  #sendControlMessage(session: ActiveRdSession, payload: ControlServerMessage): void {
    const dc = session.controlDc;
    if (!dc || dc.readyState !== "open") return;
    try {
      dc.send(JSON.stringify(payload));
    } catch {
      // ignore closed data channel write
    }
  }

  #enqueueLocalCandidate(session: ActiveRdSession, candidate: RdIceCandidate): void {
    session.iceQueue.push(candidate);
    if (session.iceQueue.length >= MAX_ICE_BATCH) {
      this.#flushLocalCandidates(session);
      return;
    }
    if (!session.iceFlushTimer) {
      session.iceFlushTimer = setTimeout(() => {
        session.iceFlushTimer = null;
        this.#flushLocalCandidates(session);
      }, ICE_BATCH_FLUSH_MS);
    }
  }

  #flushLocalCandidates(session: ActiveRdSession): void {
    if (session.iceFlushTimer) {
      clearTimeout(session.iceFlushTimer);
      session.iceFlushTimer = null;
    }
    if (session.closed || session.iceQueue.length === 0) return;
    const batch = session.iceQueue.splice(0, MAX_ICE_BATCH);
    this.#events?.onIce(session.peerDeviceId, session.sessionId, batch);
    if (session.iceQueue.length > 0) {
      session.iceFlushTimer = setTimeout(() => {
        session.iceFlushTimer = null;
        this.#flushLocalCandidates(session);
      }, ICE_BATCH_FLUSH_MS);
    }
  }

  async #disposeSession(
    session: ActiveRdSession,
    notifyPeer: boolean,
    errorMessage?: string,
  ): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    this.#sessions.delete(session.sessionId);
    if (session.iceFlushTimer) {
      clearTimeout(session.iceFlushTimer);
      session.iceFlushTimer = null;
    }
    session.iceQueue.length = 0;
    if (session.statsTimer) {
      clearInterval(session.statsTimer);
      session.statsTimer = null;
    }
    if (this.#latestClipboardRecipient === session) {
      this.#latestClipboardRecipient = null;
    }
    session.streamer.close();
    this.#bridge?.releaseInputs();
    const transfer = session.fileTransfer;
    session.fileTransfer = null;
    session.clipboardInbound = null;
    await transfer?.dispose().catch(() => {});
    await session.pc.close().catch(() => {});
    if (this.#sessions.size > 0) {
      this.#applyStreamOptions();
      this.#applyBitrate();
    } else {
      this.#appliedStreamOptions = null;
    }

    if (notifyPeer) {
      this.#events?.onState(session.peerDeviceId, session.sessionId, {
        state: "closed",
        ...(errorMessage ? { error: errorMessage } : {}),
      });
    }

    this.#scheduleHelperStopIfIdle();
  }

  #ensureIdleSweep(): void {
    if (this.#idleTimer) return;
    this.#idleTimer = setInterval(() => {
      const now = Date.now();
      for (const session of [...this.#sessions.values()]) {
        if (now - session.lastActiveAt > SESSION_IDLE_TIMEOUT_MS) {
          void this.#disposeSession(session, true, "远程桌面空闲超时已断开");
        }
      }
      if (this.#sessions.size === 0 && this.#idleTimer) {
        clearInterval(this.#idleTimer);
        this.#idleTimer = null;
      }
    }, 30_000);
    this.#idleTimer.unref?.();
  }

  #scheduleHelperStopIfIdle(): void {
    if (this.#sessions.size > 0 || !this.#bridge) return;
    if (this.#helperStopTimer) clearTimeout(this.#helperStopTimer);
    if (this.#helperIdleGraceMs <= 0) {
      void this.#bridge.close().catch(() => {});
      return;
    }
    this.#helperStopTimer = setTimeout(() => {
      this.#helperStopTimer = null;
      if (this.#sessions.size === 0) {
        void this.#bridge?.close().catch(() => {});
      }
    }, this.#helperIdleGraceMs);
    this.#helperStopTimer.unref?.();
  }
}
