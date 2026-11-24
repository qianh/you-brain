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

import { MacOsRemoteDesktopBridge, type RemoteDesktopHostBridge } from "./host-macos.js";
import { LowLatencyH264RtpStreamer } from "./rtp-h264.js";
import {
  DEFAULT_CLIENT_ICE_SERVERS,
  QUALITY_PRESETS,
  type ControlClientMessage,
  type ControlServerMessage,
  type FastInputMessage,
  type HostStateSnapshot,
  type RemoteDesktopSignalingEvents,
} from "./types.js";

const MAX_SESSIONS = 2;
const SESSION_IDLE_TIMEOUT_MS = 10 * 60_000;
const ICE_BATCH_FLUSH_MS = 15;
const MAX_ICE_BATCH = 32;

export interface RemoteDesktopPort {
  readonly supported: boolean;
  setSignalingEvents(events: RemoteDesktopSignalingEvents | null): void;
  openSession(fromDeviceId: string, args: RdOpenArgs): Promise<RdOpenResult>;
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
  #latestClipboardRecipient: ActiveRdSession | null = null;

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

  async openSession(fromDeviceId: string, args: RdOpenArgs): Promise<RdOpenResult> {
    if (!this.supported || !this.#bridge) {
      throw new Error("当前设备不支持远程桌面宿主");
    }

    const existing = this.#sessions.get(args.sessionId);
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
    const snapshot = await this.#bridge.ensureStarted({
      quality,
      ...(args.displayId !== undefined ? { displayId: args.displayId } : {}),
      promptPermissions: false,
    });

    let iceEntries: IceServerEntry[];
    try {
      iceEntries = await this.#getIceServers();
    } catch {
      iceEntries = DEFAULT_CLIENT_ICE_SERVERS;
    }

    const hasIceServers = iceEntries.length > 0;
    const pc = new RTCPeerConnection({
      iceServers: toWeriftIceServers(iceEntries),
      iceUseDefaultStunServer: hasIceServers,
      iceAdditionalHostAddresses: ["127.0.0.1"],
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
      sessionId: args.sessionId,
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
    };

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
        this.#sendControlMessage(session, {
          t: "state",
          displays: state.displays,
          activeDisplayId: state.activeDisplayId,
          permissions: state.permissions,
          quality: session.quality,
        });
        this.#events?.onState(session.peerDeviceId, session.sessionId, {
          state: "ready",
          displays: state.displays,
          activeDisplayId: state.activeDisplayId,
          permissions: state.permissions,
        });
      }
    });

    this.#unsubClipboard = bridge.subscribeClipboard((text) => {
      const target = this.#latestClipboardRecipient;
      if (target && !target.closed) {
        this.#sendControlMessage(target, { t: "cb", text });
        return;
      }
      for (const session of this.#sessions.values()) {
        if (!session.closed) {
          this.#sendControlMessage(session, { t: "cb", text });
        }
      }
    });

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

    if (dc.label === "control") {
      session.controlDc = dc;
      const sendInitialState = () => {
        if (session.closed || !this.#bridge) return;
        const snap: HostStateSnapshot = this.#bridge.getStateSnapshot();
        this.#sendControlMessage(session, {
          t: "state",
          displays: snap.displays,
          activeDisplayId: snap.activeDisplayId,
          permissions: snap.permissions,
          quality: session.quality,
        });
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
              void this.#reconfigureBridge(session);
            }
            return;
          case "cb.get":
            this.#latestClipboardRecipient = session;
            this.#bridge?.handleControlInput(msg);
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
      if (!session.closed) {
        this.#sendControlMessage(session, {
          t: "state",
          displays: snap.displays,
          activeDisplayId: snap.activeDisplayId,
          permissions: snap.permissions,
          quality: session.quality,
        });
        this.#bridge.requestKeyframe();
      }
    } catch {
      // ignore transient reconfigure error
    }
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
    if (this.#latestClipboardRecipient === session) {
      this.#latestClipboardRecipient = null;
    }
    session.streamer.close();
    this.#bridge?.releaseInputs();
    await session.pc.close().catch(() => {});

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
