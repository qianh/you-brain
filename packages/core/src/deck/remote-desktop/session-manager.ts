import { randomBytes, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  type RtpPacket,
  type RTCDataChannel,
  type RTCIceServer,
  type RTCRtpSender,
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
import { nextStreamTier, streamProfileFor, type StreamTier } from "./stream-profile.js";
import { HostFileTransfer, type FileChannelPort } from "./file-transfer.js";
import { MacOsRemoteDesktopBridge, type RemoteDesktopHostBridge } from "./host-macos.js";
import {
  inspectLocalIceInterfaces,
  isBlockedIceCandidateLine,
  isProxyFakeOrBogusIp,
  isUnspecifiedIp,
  resolveDirectStunIceServers,
  stripBlockedIceCandidatesFromSdp,
} from "./net-ice.js";
import { KeyframeGate } from "./keyframe-gate.js";
import { NackRateMeter, RtpSendHistory } from "./retransmit.js";
import { LowLatencyH264RtpStreamer, type FecSenderPort } from "./rtp-h264.js";
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
  type HostVideoCounters,
  type RdPipelineStats,
  type RemoteDesktopSignalingEvents,
} from "./types.js";

const MAX_SESSIONS = 2;
const SESSION_IDLE_TIMEOUT_MS = 10 * 60_000;
const ICE_BATCH_FLUSH_MS = 15;
const MAX_ICE_BATCH = 32;
const STATS_INTERVAL_MS = 2_000;
const FILE_DRAIN_LOW_WATER = 1024 * 1024;
const MAX_DOWNLOAD_ALLOW = 200;
const MDNS_LOOKUP_TIMEOUT_MS = 500;
const ICE_FAILED_MESSAGE = "远程桌面连接失败：P2P 直连与 TURN 中继均未打通";

export type MdnsHostLookup = (hostname: string) => Promise<string | null>;

const CANDIDATE_ADDR_RE = /^((?:a=)?candidate:\S+\s+\d+\s+\S+\s+\d+\s+)([^\s]+)(\s+\d+\s+typ\s+\S+.*)$/iu;

function defaultMdnsLookup(hostname: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), MDNS_LOOKUP_TIMEOUT_MS);
    timer.unref?.();
    dnsLookup(hostname, { family: 4 })
      .then((res) => {
        clearTimeout(timer);
        resolve(res.address || null);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}

/**
 * 浏览器常将局域网 host 候选隐藏为 `<uuid>.local`。
 * `werift` 内置 mDNS 解析器只检查 `answers[0]`，在 macOS 返回 AAAA/NSEC 首记录时会超时失败并被迫回落到高延迟跨国 TURN。
 * 这里直接通过系统 mDNSResponder 解析成局域网 IPv4，使同网段设备优先走 <2ms P2P 直连。
 */
export async function resolveMdnsIceCandidate(
  candidate: string,
  cache: Map<string, Promise<string | null>>,
  lookupFn: MdnsHostLookup = defaultMdnsLookup,
): Promise<string | null> {
  const match = CANDIDATE_ADDR_RE.exec(candidate.trim());
  if (!match) return candidate;
  const [, prefix, host, suffix] = match;
  if (!host || !host.toLowerCase().endsWith(".local")) return candidate;
  let pending = cache.get(host.toLowerCase());
  if (!pending) {
    pending = lookupFn(host);
    cache.set(host.toLowerCase(), pending);
  }
  const resolved = await pending;
  if (!resolved || isProxyFakeOrBogusIp(resolved)) return null;
  return `${prefix}${resolved}${suffix}`;
}

async function rewriteMdnsInSdp(
  sdp: string,
  cache: Map<string, Promise<string | null>>,
  lookupFn: MdnsHostLookup,
  blockedIps?: ReadonlySet<string>,
): Promise<string> {
  const cleaned = stripBlockedIceCandidatesFromSdp(sdp, blockedIps);
  if (!cleaned.includes(".local")) return cleaned;
  const lines = cleaned.split(/\r?\n/);
  const out = await Promise.all(
    lines.map(async (line) => {
      if (!line.startsWith("a=candidate:") || !line.includes(".local")) return line;
      const resolved = await resolveMdnsIceCandidate(line, cache, lookupFn);
      if (!resolved || isBlockedIceCandidateLine(resolved, blockedIps)) return "";
      return resolved;
    }),
  );
  return out.filter((line, idx) => line !== "" || lines[idx] === "").join("\r\n");
}

function isBlockedWeriftCandidate(
  candidate: { host?: string | undefined; relatedAddress?: string | undefined } | undefined,
  blockedIps: ReadonlySet<string>,
): boolean {
  if (!candidate) return false;
  if (candidate.host && !candidate.host.toLowerCase().endsWith(".local") && isProxyFakeOrBogusIp(candidate.host, blockedIps)) {
    return true;
  }
  // 浏览器 srflx / relay 候选的 relatedAddress 是 0.0.0.0 / :: 隐私占位，不能据此过滤候选对。
  if (
    candidate.relatedAddress &&
    !isUnspecifiedIp(candidate.relatedAddress) &&
    isProxyFakeOrBogusIp(candidate.relatedAddress, blockedIps)
  ) {
    return true;
  }
  return false;
}

/** 读取发送端 remote-inbound-rtp 统计，返回自上次读取以来新增 RTT 样本的平均值（毫秒）。 */
function takeNewRttSampleMs(
  sender: { collectStats(timestamp: number): unknown[] },
  tracker: { total: number; count: number },
): number | null {
  let remote: { totalRoundTripTime?: unknown; roundTripTimeMeasurements?: unknown } | undefined;
  try {
    remote = sender
      .collectStats(Date.now())
      .find((entry) => (entry as { type?: unknown }).type === "remote-inbound-rtp") as typeof remote;
  } catch {
    return null;
  }
  const total = remote?.totalRoundTripTime;
  const count = remote?.roundTripTimeMeasurements;
  if (typeof total !== "number" || typeof count !== "number" || count <= tracker.count) return null;
  const avgSeconds = (total - tracker.total) / (count - tracker.count);
  tracker.total = total;
  tracker.count = count;
  return avgSeconds > 0 ? avgSeconds * 1000 : null;
}

function profileKey(profile: { maxDimension: number; fps: number }): string {
  return `${profile.maxDimension}x${profile.fps}`;
}

/** 一次统计时刻的视频管线累计计数。 */
export interface PipelineSample {
  at: number;
  /** 原生助手计数，旧版助手为 null。 */
  host: HostVideoCounters | null;
  sent: number;
  dropped: number;
}

/** 由前后两次累计计数算出各环节每秒帧数；计数回退（助手重启）的环节记为 null。 */
export function computePipelineStats(
  prev: PipelineSample,
  cur: PipelineSample,
  profile: { maxDimension: number; fps: number },
): RdPipelineStats | null {
  const seconds = (cur.at - prev.at) / 1000;
  if (!(seconds > 0)) return null;
  const rate = (before: number, after: number): number | null =>
    after >= before ? Math.round(((after - before) / seconds) * 10) / 10 : null;
  const host = prev.host && cur.host ? { prev: prev.host, cur: cur.host } : null;
  return {
    targetFps: profile.fps,
    maxDimension: profile.maxDimension,
    captured: host ? rate(host.prev.captured, host.cur.captured) : null,
    encoderBusy: host ? rate(host.prev.busy, host.cur.busy) : null,
    encoderDropped: host ? rate(host.prev.dropped, host.cur.dropped) : null,
    encoded: host ? rate(host.prev.encoded, host.cur.encoded) : null,
    sent: rate(prev.sent, cur.sent) ?? 0,
    sendDropped: rate(prev.dropped, cur.dropped) ?? 0,
  };
}

function isPeerConnectionUsingRelay(pc: RTCPeerConnection): boolean {
  const transports = (
    pc as unknown as {
      iceTransports?: Array<{
        connection?: {
          nominated?: {
            localCandidate?: { type?: string };
            remoteCandidate?: { type?: string };
          };
        };
      }>;
    }
  ).iceTransports;
  const nominated = transports?.[0]?.connection?.nominated;
  if (!nominated) return false;
  return nominated.localCandidate?.type === "relay" || nominated.remoteCandidate?.type === "relay";
}

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
  /** 上一次统计时的视频管线计数，用于换算每秒帧数。 */
  pipeSample: PipelineSample | null;
  clipboardInbound: { id: string; n: number; parts: string[]; received: number; chars: number } | null;
  /** 最近一次应用的鼠标移动序号，丢弃无序通道上晚到的旧坐标。 */
  lastMoveSeq: number;
  /** 当前选中的候选对是否经 TURN 中继。 */
  relay: boolean;
  mdnsCache: Map<string, Promise<string | null>>;
  blockedIps: ReadonlySet<string>;
  /** 串行投递远端候选，保证结束标记不会越过尚在 mDNS 解析中的真实候选。 */
  remoteIceChain: Promise<void>;
}

function acceptMoveSeq(session: ActiveRdSession, seq: number | undefined): boolean {
  if (typeof seq !== "number" || !Number.isFinite(seq)) return true;
  if (seq <= session.lastMoveSeq) return false;
  session.lastMoveSeq = seq;
  return true;
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

/** 控制端 offer 里带 flexfec-03（Safari/WKWebView 默认带）时，宿主额外协商它并发送修复包。 */
const FLEXFEC_MIME = "video/flexfec-03";

function offerHasFlexfec(sdp: string): boolean {
  return /^a=rtpmap:\d+ flexfec-03\/90000/im.test(sdp);
}

/** answer 里协商出的 flexfec-03 负载类型；未协商返回 null。 */
export function flexfecPayloadTypeOf(sdp: string): number | null {
  const match = /^a=rtpmap:(\d+) flexfec-03\/90000/im.exec(sdp);
  return match ? Number(match[1]) : null;
}

/**
 * 在 answer 里为修复流声明独立 SSRC：复制媒体 SSRC 的 a=ssrc 行并加 `a=ssrc-group:FEC-FR`，
 * 接收端据此把修复包关联到被保护的媒体流。
 */
export function addFlexfecSsrcToSdp(sdp: string, mediaSsrc: number, fecSsrc: number): string {
  const prefix = `a=ssrc:${mediaSsrc >>> 0} `;
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const out: string[] = [];
  let grouped = false;
  for (const line of sdp.split(eol)) {
    if (!grouped && line.startsWith(prefix)) {
      out.push(`a=ssrc-group:FEC-FR ${mediaSsrc >>> 0} ${fecSsrc >>> 0}`);
      grouped = true;
    }
    out.push(line);
    if (line.startsWith(prefix)) out.push(`a=ssrc:${fecSsrc >>> 0} ${line.slice(prefix.length)}`);
  }
  return out.join(eol);
}

function buildH264Codecs(withFlexfec = false): RTCRtpCodecParameters[] {
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
    ...(withFlexfec
      ? [new RTCRtpCodecParameters({ mimeType: FLEXFEC_MIME, clockRate: 90_000, parameters: "repair-window=10000000" })]
      : []),
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
  mdnsLookup?: MdnsHostLookup;
}

export class RemoteDesktopHostManager implements RemoteDesktopPort {
  readonly supported: boolean;
  readonly #bridge: RemoteDesktopHostBridge | null;
  readonly #getIceServers: () => Promise<IceServerEntry[]> | IceServerEntry[];
  readonly #helperIdleGraceMs: number;
  readonly #iceStunGatherTimeoutSec: number;
  readonly #mdnsLookup: MdnsHostLookup;
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
  /** 多会话共用一路编码，关键帧请求统一限频（见 keyframe-gate.ts）。 */
  readonly #keyframes = new KeyframeGate({ send: () => this.#bridge?.requestKeyframe() });
  /** 共用编码当前所处的链路档位与切换时间（见 stream-profile.ts）。 */
  #streamTier: StreamTier = "direct";
  #streamTierAt = 0;
  /** 已下发给助手的分辨率上限×帧率；null 表示助手当前为某个画质预设，需要重新比对。 */
  #appliedProfileKey: string | null = null;

  constructor(options?: RemoteDesktopHostManagerOptions) {
    this.supported = options?.supported ?? process.platform === "darwin";
    this.#bridge =
      options?.bridge ?? (this.supported ? new MacOsRemoteDesktopBridge() : null);
    this.#getIceServers = options?.getIceServers ?? (() => DEFAULT_CLIENT_ICE_SERVERS);
    this.#helperIdleGraceMs = options?.helperIdleGraceMs ?? 2_000;
    this.#iceStunGatherTimeoutSec = options?.iceStunGatherTimeoutSec ?? 1.5;
    this.#mdnsLookup = options?.mdnsLookup ?? defaultMdnsLookup;

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
    const mdnsCache = new Map<string, Promise<string | null>>();
    const localIce = inspectLocalIceInterfaces();
    const [snapshot, iceEntries, rewrittenOfferSdp] = await Promise.all([
      this.#bridge.ensureStarted({
        quality,
        ...(args.displayId !== undefined ? { displayId: args.displayId } : {}),
        promptPermissions: false,
      }),
      (overrideIceServers
        ? Promise.resolve(overrideIceServers)
        : Promise.resolve()
            .then(() => this.#getIceServers())
            .catch(() => DEFAULT_CLIENT_ICE_SERVERS)
      ).then((entries) => resolveDirectStunIceServers(entries)),
      rewriteMdnsInSdp(args.offerSdp, mdnsCache, this.#mdnsLookup, localIce.blockedIps),
    ]);
    // 新开流以预设码率起步；自适应控制器随后按丢包调整。
    this.#appliedBitrate = null;
    // ensureStarted 按该画质预设配置了助手，档位需重新比对下发。
    this.#appliedProfileKey = profileKey(QUALITY_PRESETS[quality]);

    const hasIceServers = iceEntries.length > 0;
    const preferredHostAddresses = !hasIceServers
      ? ["127.0.0.1"]
      : localIce.preferredHostAddresses.length > 0
        ? localIce.preferredHostAddresses
        : undefined;
    const pc = new RTCPeerConnection({
      iceServers: toWeriftIceServers(iceEntries),
      iceUseDefaultStunServer: false,
      iceUseLinkLocalAddress: false,
      iceRenomination: true,
      ...(preferredHostAddresses ? { iceAdditionalHostAddresses: preferredHostAddresses } : {}),
      iceFilterCandidatePair: (pair) =>
        !isBlockedWeriftCandidate(pair.localCandidate, localIce.blockedIps) &&
        !isBlockedWeriftCandidate(pair.remoteCandidate, localIce.blockedIps),
      iceStunGatherTimeout: this.#iceStunGatherTimeoutSec,
      codecs: { video: buildH264Codecs(offerHasFlexfec(rewrittenOfferSdp)) },
      pendingRtp: { enabled: true, maxLength: 96 },
    });

    const videoTrack = new MediaStreamTrack({ kind: "video", streamId: "ubrain-rd" });
    const transceiver = pc.addTransceiver(videoTrack, { direction: "sendonly" });
    const sender = transceiver.sender;
    // FlexFEC：协商成功后（见 answer 处理）才启用；修复流用独立 SSRC 与序号。
    let fecPort: FecSenderPort | undefined;
    const sendHistory = new RtpSendHistory<RtpPacket>();
    const nackMeter = new NackRateMeter();
    /** werift 按 seq % 128（RTP_HISTORY_SIZE）缓存已发包；序号不符说明已被覆盖。 */
    const weriftCached = (sequenceNumber: number): RtpPacket | undefined => {
      const cache = (sender as unknown as { rtpCache?: Array<RtpPacket | undefined> }).rtpCache;
      const packet = cache?.[sequenceNumber % 128];
      return packet && packet.header.sequenceNumber === sequenceNumber ? packet : undefined;
    };
    const fecSsrc = randomBytes(4).readUInt32BE(0) || 1;
    let fecSeq = randomBytes(2).readUInt16BE(0);
    const enableFlexfec = (payloadType: number) => {
      fecPort = {
        sentPacket(sequenceNumber) {
          return weriftCached(sequenceNumber)?.serialize() ?? null;
        },
        async sendRepair(payload, timestamp) {
          const header = new RtpHeader({ payloadType, sequenceNumber: fecSeq, timestamp, ssrc: fecSsrc, marker: false });
          fecSeq = (fecSeq + 1) & 0xffff;
          await sender.dtlsTransport?.sendRtp(payload, header);
        },
      };
    };

    const streamer = new LowLatencyH264RtpStreamer(
      {
        get ssrc() {
          return sender.ssrc;
        },
        get payloadType() {
          return sender.codec?.payloadType ?? 96;
        },
        async sendRtp(packet) {
          await sender.sendRtp(packet);
          nackMeter.noteSent();
          // 存 werift 实际发出的那个对象（序号、时间戳已按其连续性映射），重传时原样发
          const sent = weriftCached(packet.header.sequenceNumber);
          if (sent) sendHistory.put(sent.header.sequenceNumber, sent);
        },
        get fec() {
          return fecPort;
        },
      },
      {
        onDropNeedKeyframe: () => {
          this.#keyframes.request("drop", session.bitrate.lastRttMs);
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
      pipeSample: null,
      clipboardInbound: null,
      lastMoveSeq: -1,
      relay: false,
      mdnsCache,
      blockedIps: localIce.blockedIps,
      remoteIceChain: Promise.resolve(),
    };

    const rttTracker = { total: 0, count: 0 };
    sender.onRtcp.subscribe((packet) => {
      if (session.closed) return;
      const reports = (packet as { reports?: Array<{ ssrc: number; fractionLost: number }> }).reports;
      if (!Array.isArray(reports)) return;
      for (const report of reports) {
        if (report.ssrc === sender.ssrc) {
          const now = Date.now();
          // 先判排队再按丢包加速：同一份报告不丢包但 RTT 已在涨时，不能先把码率加上去。
          // werift 在触发 onRtcp 前已按 LSR/DLSR 记下 RTT；取两次报告间新增样本的均值。
          const rttMs = takeNewRttSampleMs(sender, rttTracker);
          if (rttMs !== null) session.bitrate.onRoundTripTime(rttMs, now);
          session.bitrate.onReceiverReport(report.fractionLost, now, nackMeter.take());
          session.streamer.setLossHint(session.bitrate.lastLoss);
        }
      }
    });

    sender.onKeyFrameRequest.subscribe(() => {
      if (!session.closed) {
        this.#keyframes.request("pli", session.bitrate.lastRttMs);
      }
    });

    sender.onGenericNack.subscribe((feedback) => {
      if (session.closed) return;
      nackMeter.noteNack(feedback.lost);
      // werift 已处理仍在其 128 包缓存里的序号；被挤出的从更长的历史里补发
      for (const seq of feedback.lost) {
        if (weriftCached(seq)) continue;
        const packet = sendHistory.get(seq);
        if (packet) void this.#retransmit(sender, packet);
      }
    });

    pc.onIceCandidate.subscribe((candidate) => {
      if (session.closed || !candidate || !candidate.candidate) return;
      if (isBlockedIceCandidateLine(candidate.candidate, session.blockedIps)) return;
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
        session.relay = isPeerConnectionUsingRelay(pc);
        session.bitrate.setRelayMode(session.relay);
        this.#applyStreamProfile();
        this.#startStats(session);
        this.#keyframes.force();
        const cur = this.#bridge?.getStateSnapshot() ?? snapshot;
        this.#events?.onState(session.peerDeviceId, session.sessionId, {
          state: "ready",
          displays: cur.displays,
          activeDisplayId: cur.activeDisplayId,
          permissions: cur.permissions,
        });
      } else if (state === "failed") {
        // 建连失败要带原因上报，否则控制端只能显示“已断开”，看不出是 ICE 没打通。
        this.#events?.onState(session.peerDeviceId, session.sessionId, {
          state: "error",
          error: ICE_FAILED_MESSAGE,
        });
        void this.#disposeSession(session, false);
      } else if (state === "closed") {
        void this.#disposeSession(session, true);
      }
    });

    pc.onDataChannel.subscribe((dc) => {
      if (session.closed) return;
      this.#attachDataChannel(session, dc);
    });

    try {
      await pc.setRemoteDescription({ type: "offer", sdp: rewrittenOfferSdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      let rawAnswerSdp = pc.localDescription?.sdp ?? answer.sdp;
      const flexfecPt = flexfecPayloadTypeOf(rawAnswerSdp);
      if (flexfecPt !== null && sender.codec?.mimeType.toLowerCase() === "video/h264") {
        rawAnswerSdp = addFlexfecSsrcToSdp(rawAnswerSdp, sender.ssrc, fecSsrc);
        enableFlexfec(flexfecPt);
      }
      const answerSdp = stripBlockedIceCandidatesFromSdp(rawAnswerSdp, session.blockedIps);
      this.#sessions.set(session.sessionId, session);
      this.#applyStreamOptions();
      this.#ensureIdleSweep();
      this.#keyframes.force();
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
    // mDNS 解析可以并发，但交给 werift 时必须保持到达顺序（跨批次也一样）：
    // 结束标记（空候选）一旦先于真实候选送达，werift 会在本地收集结束时以空检查表直接判定 ICE 失败。
    const resolving = args.candidates.map((item) =>
      item.candidate
        ? resolveMdnsIceCandidate(item.candidate, session.mdnsCache, this.#mdnsLookup)
        : Promise.resolve(null),
    );
    const run = session.remoteIceChain.then(async () => {
      for (const [idx, item] of args.candidates.entries()) {
        if (session.closed) return;
        if (!item.candidate) {
          await session.pc.addIceCandidate(null).catch(() => {});
          continue;
        }
        const resolved = await resolving[idx];
        if (!resolved || session.closed || isBlockedIceCandidateLine(resolved, session.blockedIps)) continue;
        await session.pc
          .addIceCandidate({
            candidate: resolved,
            sdpMid: item.sdpMid ?? null,
            sdpMLineIndex: item.sdpMLineIndex ?? null,
            usernameFragment: item.usernameFragment ?? null,
          })
          .catch(() => {});
      }
    });
    session.remoteIceChain = run.catch(() => {});
    await run;
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
    this.#appliedProfileKey = null;
    this.#streamTier = "direct";
    this.#keyframes.close();
    this.#lastCursor = null;
    if (this.#bridge) {
      this.#bridge.releaseInputs();
      await this.#bridge.close().catch(() => {});
    }
  }

  #bindBridge(bridge: RemoteDesktopHostBridge): void {
    this.#unsubVideo = bridge.subscribeVideo((frame) => {
      if (frame.keyframe) this.#keyframes.noteKeyframe();
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
          if (!msg) return;
          if (msg.t === "mm") {
            if (!acceptMoveSeq(session, msg.seq)) return;
            this.#bridge?.handleFastInput(msg);
          } else if (msg.t === "wh") {
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
        // 主动推送已缓存的系统光标形状，免去控制端等待 cfg 往返（高 RTT TURN 链路可立省 400ms+）。
        if (this.#lastCursor) {
          this.#sendControlMessage(session, { t: "cursor", ...this.#lastCursor });
        }
        this.#keyframes.force();
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
          case "mm":
            if (!acceptMoveSeq(session, msg.seq)) return;
            this.#bridge?.handleControlInput(msg);
            return;
          case "md":
          case "mu":
            if (typeof msg.seq === "number" && Number.isFinite(msg.seq) && msg.seq > session.lastMoveSeq) {
              session.lastMoveSeq = msg.seq;
            }
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
      // 重新配置会把编码码率、分辨率和帧率重置为预设值，之后需重新下发自适应码率与链路档位。
      this.#appliedBitrate = null;
      this.#applyBitrate();
      this.#appliedProfileKey = profileKey(QUALITY_PRESETS[session.quality]);
      this.#applyStreamProfile();
      if (!session.closed) {
        this.#sendControlMessage(session, this.#stateMessage(session, snap));
        this.#keyframes.force();
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

  /** 按 NACK 补发已被挤出 werift 缓存的包；走其内部发送路径以计入重传统计，私有接口缺失时直接写 DTLS。 */
  async #retransmit(sender: RTCRtpSender, packet: RtpPacket): Promise<void> {
    const internal = sender as unknown as {
      sendRtpInternal?: (rtp: RtpPacket, opts: { injectProbePadding: boolean; isRetransmission: boolean }) => Promise<void>;
      dispatchOutgoing?: (task: () => Promise<void>, meta: { kind: string; bytes: number }) => Promise<void>;
    };
    try {
      if (typeof internal.sendRtpInternal === "function" && typeof internal.dispatchOutgoing === "function") {
        await internal.dispatchOutgoing.call(
          sender,
          () => internal.sendRtpInternal!.call(sender, packet, { injectProbePadding: false, isRetransmission: true }),
          { kind: "rtx", bytes: packet.header.serializeSize + packet.payload.length },
        );
      } else {
        await sender.dtlsTransport?.sendRtp(packet.payload, packet.header);
      }
    } catch {
      // 连接关闭期间写包异常安全忽略
    }
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

  /**
   * 按链路选择共用编码的分辨率上限与帧率：任一会话走 TURN 中继即降档（见 stream-profile.ts），
   * 多会话取最保守的画质预设，避免为某个会话把画面推回高分辨率高帧率。
   */
  #applyStreamProfile(): void {
    if (!this.#bridge?.setStreamProfile) return;
    const live = [...this.#sessions.values()].filter((item) => !item.closed);
    if (live.length === 0) return;
    const now = Date.now();
    const targetBps = Math.min(...live.map((item) => item.bitrate.targetBps));
    // 多个中继会话取最差的基线 RTT；任一未知则视为未知，不放开画质。
    const relayRtts = live.filter((item) => item.relay).map((item) => item.bitrate.baseRttMs);
    const rttMs = relayRtts.length === 0 || relayRtts.some((rtt) => rtt === null)
      ? null
      : Math.max(...(relayRtts as number[]));
    const tier = nextStreamTier({
      current: this.#streamTier,
      relay: live.some((item) => item.relay),
      targetBps,
      nowMs: now,
      changedAtMs: this.#streamTierAt,
      rttMs,
    });
    if (tier !== this.#streamTier) {
      this.#streamTier = tier;
      this.#streamTierAt = now;
    }
    const profile = streamProfileFor(tier, {
      maxDimension: Math.min(...live.map((item) => QUALITY_PRESETS[item.quality].maxDimension)),
      fps: Math.min(...live.map((item) => QUALITY_PRESETS[item.quality].fps)),
    });
    const key = profileKey(profile);
    if (key === this.#appliedProfileKey) return;
    this.#appliedProfileKey = key;
    this.#bridge.setStreamProfile({ ...profile, bitrateBps: this.#appliedBitrate ?? targetBps });
  }

  /** 当前下发给编码的分辨率上限与帧率（尚未按链路收紧时为画质预设）。 */
  #currentProfile(session: ActiveRdSession): { maxDimension: number; fps: number } {
    const [dim, fps] = (this.#appliedProfileKey ?? "").split("x").map(Number);
    if (dim !== undefined && fps !== undefined && dim > 0 && fps > 0) return { maxDimension: dim, fps };
    const preset = QUALITY_PRESETS[session.quality];
    return { maxDimension: preset.maxDimension, fps: preset.fps };
  }

  #startStats(session: ActiveRdSession): void {
    if (session.statsTimer) return;
    session.statsTimer = setInterval(() => {
      if (session.closed) return;
      session.relay = isPeerConnectionUsingRelay(session.pc);
      session.bitrate.setRelayMode(session.relay);
      this.#applyStreamProfile();
      const sample: PipelineSample = {
        at: Date.now(),
        host: this.#bridge?.pollVideoCounters?.() ?? null,
        ...session.streamer.counters,
      };
      const pipe = session.pipeSample
        ? computePipelineStats(session.pipeSample, sample, this.#currentProfile(session))
        : null;
      session.pipeSample = sample;
      this.#sendControlMessage(session, {
        t: "stats",
        bitrateBps: this.#appliedBitrate ?? session.bitrate.targetBps,
        lossPct: Math.round(session.bitrate.lastLoss * 1000) / 10,
        rttMs: session.bitrate.lastRttMs === null ? null : Math.round(session.bitrate.lastRttMs),
        ...(pipe ? { pipe } : {}),
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
      this.#applyStreamProfile();
    } else {
      this.#appliedStreamOptions = null;
      this.#streamTier = "direct";
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
