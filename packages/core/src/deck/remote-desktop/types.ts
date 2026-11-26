import type { IceServerEntry, RdDisplayInfo, RdIceCandidate, RdPermissions, RdQuality } from "@you-brain/protocol";

export interface QualityPreset {
  quality: RdQuality;
  maxDimension: number;
  fps: number;
  bitrateBps: number;
}

export const QUALITY_PRESETS: Record<RdQuality, QualityPreset> = {
  smooth: {
    quality: "smooth",
    maxDimension: 1600,
    fps: 60,
    bitrateBps: 4_000_000,
  },
  hd: {
    quality: "hd",
    maxDimension: 1920,
    fps: 60,
    bitrateBps: 8_500_000,
  },
  ultra: {
    quality: "ultra",
    maxDimension: 2560,
    fps: 60,
    bitrateBps: 16_000_000,
  },
};

export const DEFAULT_CLIENT_ICE_SERVERS: IceServerEntry[] = [
  {
    urls: [
      "stun:stun.chat.bilibili.com:3478",
      "stun:stun.miwifi.com:3478",
    ],
  },
];

/** 控制通道单条剪贴板文本分片的最大字符数（UTF-8 最坏 4 字节，远低于浏览器 256KB SCTP 消息上限）。 */
export const CLIPBOARD_CHUNK_CHARS = 48_000;
/** 剪贴板文本同步上限（字符）。 */
export const CLIPBOARD_MAX_CHARS = 4_000_000;
/** 文件通道单个二进制分片大小。16KB 兼容所有 WebRTC 实现的 SCTP 消息上限。 */
export const FILE_CHUNK_BYTES = 16 * 1024;
/** 单个传输文件上限。 */
export const FILE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
/** 远端剪贴板图片的虚拟下载路径。 */
export const CLIPBOARD_IMAGE_PATH = "clipboard:image";
/** 剪贴板图片上限：经助手控制套接字以 base64 单行传递，需低于其 32MB 行缓冲。 */
export const CLIPBOARD_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export interface EncodedVideoFrame {
  keyframe: boolean;
  ptsUs: number;
  sps: Buffer | null;
  pps: Buffer | null;
  avcc: Buffer;
}

export interface HostStateSnapshot {
  displays: RdDisplayInfo[];
  activeDisplayId: number;
  permissions: RdPermissions;
  /** 远端系统双击判定间隔（毫秒），控制端据此计算多击。 */
  doubleClickMs?: number;
}

/** 远端系统光标形状（控制端本地渲染，零延迟跟手）。 */
export interface HostCursorShape {
  /** PNG base64（按 Retina 像素输出）；为空表示光标隐藏。 */
  png: string;
  /** 热点（点）。 */
  hx: number;
  hy: number;
  /** 尺寸（点）。 */
  w: number;
  h: number;
}

export interface HostClipboardFile {
  path: string;
  name: string;
  size: number;
}

export interface HostClipboardEvent {
  /** 剪贴板变化由宿主监听自动发现（而非控制端主动拉取）。 */
  auto?: boolean;
  files?: HostClipboardFile[];
  /** 剪贴板里是图片（无文字、无文件）时的像素尺寸；图片数据按需经 `file` 通道下载。 */
  image?: { w: number; h: number };
}

/** 宿主侧需要按会话汇总后下发给原生助手的流选项。 */
export interface HostStreamOptions {
  /** 光标是否画进视频画面。控制端本地渲染光标时关闭，鼠标移动不再触发整帧编码。 */
  showCursorInVideo: boolean;
  /** 是否监听并上报光标形状。 */
  cursorShape: boolean;
  /** 是否监听远端剪贴板变化并自动推送。 */
  clipboardWatch: boolean;
}

export type FastInputMessage =
  | { t: "mm"; x: number; y: number; seq?: number }
  | WheelInputMessage;

/**
 * 滚轮增量。`dx/dy` 为距上一条的增量（旧版宿主只认它）；
 * 新版控制端另带滚动流 ID `ws`、序号 `s` 与累计总量 `tx/ty`，宿主按“新总量 − 上次总量”滚动，
 * 不可靠通道上丢包或乱序都不会丢失滚动距离。
 */
export interface WheelInputMessage {
  t: "wh";
  dx: number;
  dy: number;
  x?: number;
  y?: number;
  ws?: string;
  s?: number;
  tx?: number;
  ty?: number;
}

export interface ClipboardChunkInfo {
  /** 分片批次 ID。 */
  id: string;
  /** 分片序号，从 0 开始。 */
  i: number;
  /** 分片总数。 */
  n: number;
}

export type ControlClientMessage =
  | { t: "mm"; x: number; y: number; seq?: number }
  | WheelInputMessage
  | { t: "md"; x: number; y: number; b: 0 | 1 | 2; clicks?: number; seq?: number }
  | { t: "mu"; x: number; y: number; b: 0 | 1 | 2; clicks?: number; seq?: number }
  | {
      t: "kd";
      code: string;
      meta?: boolean;
      ctrl?: boolean;
      alt?: boolean;
      shift?: boolean;
      /** 按住不放的系统自动重复。 */
      rep?: boolean;
    }
  | { t: "ku"; code: string; meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }
  | { t: "txt"; text: string }
  | { t: "cb.set"; text: string; chunk?: ClipboardChunkInfo }
  | { t: "cb.get" }
  | { t: "disp"; displayId: number }
  | { t: "qual"; quality: RdQuality }
  | { t: "idr" }
  | { t: "perm" }
  | { t: "ping"; ts: number }
  /** 控制端能力声明：本地渲染光标、自动双向剪贴板。旧客户端不发送，行为保持不变。 */
  | { t: "cfg"; localCursor?: boolean; clipboardSync?: boolean };

export type ControlServerMessage =
  | { t: "pong"; ts: number }
  | {
      t: "state";
      displays: RdDisplayInfo[];
      activeDisplayId: number;
      permissions: RdPermissions;
      quality: RdQuality;
      doubleClickMs?: number;
    }
  | { t: "cb"; text: string; auto?: boolean; chunk?: ClipboardChunkInfo }
  | { t: "cb.files"; files: Array<{ path: string; name: string; size: number }> }
  /** 远端剪贴板是图片：控制端用 `file` 通道 `get` 路径 {@link CLIPBOARD_IMAGE_PATH} 取回 PNG。 */
  | { t: "cb.image"; id: string; w: number; h: number; auto?: boolean }
  | ({ t: "cursor" } & HostCursorShape)
  | { t: "stats"; bitrateBps: number; lossPct: number; rttMs: number | null; pipe?: RdPipelineStats };

/** 宿主原生助手上报的视频管线累计计数。 */
export interface HostVideoCounters {
  /** ScreenCaptureKit 交付的完整帧（画面不变时不交付）。 */
  captured: number;
  /** 编码器积压时跳过的帧。 */
  busy: number;
  /** VideoToolbox 丢弃的帧（多为码率上限所致）。 */
  dropped: number;
  /** 编码输出的帧。 */
  encoded: number;
}

/**
 * 宿主视频管线各环节的每秒帧数，用于定位帧率低的原因（诊断用，旧版宿主不发）。
 * 采集与编码数据来自原生助手，旧版助手为 null。
 */
export interface RdPipelineStats {
  /** 当前档位的帧率上限与分辨率上限。 */
  targetFps: number;
  maxDimension: number;
  captured: number | null;
  encoderBusy: number | null;
  encoderDropped: number | null;
  encoded: number | null;
  /** 发送端完整发出的帧。 */
  sent: number;
  /** 发送队列积压被丢弃、或丢帧后等待关键帧期间跳过的帧。 */
  sendDropped: number;
}

/** `file` 通道上的 JSON 帧（二进制帧为当前传输的数据分片）。 */
export type FileClientMessage =
  /** `dest: "clipboard"` 表示这是一张图片，写入远端剪贴板而不是存进下载目录。 */
  | { t: "put"; id: string; name: string; size: number; dest?: "downloads" | "clipboard" }
  | { t: "end"; id: string }
  | { t: "cancel"; id: string }
  | { t: "get"; id: string; path: string };

export type FileServerMessage =
  | { t: "ack"; id: string; received: number }
  | { t: "saved"; id: string; path: string; name: string }
  | { t: "meta"; id: string; name: string; size: number }
  | { t: "done"; id: string }
  | { t: "error"; id: string; message: string };

export interface RemoteDesktopSignalingEvents {
  onIce(toDeviceId: string, sessionId: string, candidates: RdIceCandidate[]): void;
  onState(
    toDeviceId: string,
    sessionId: string,
    payload: {
      state: "ready" | "closed" | "error";
      displays?: RdDisplayInfo[];
      activeDisplayId?: number;
      permissions?: RdPermissions;
      error?: string;
    },
  ): void;
}
