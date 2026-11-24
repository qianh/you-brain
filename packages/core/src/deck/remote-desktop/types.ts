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
      "stun:stun.cloudflare.com:3478",
      "stun:stun.miwifi.com:3478",
      "stun:stun.qq.com:3478",
      "stun:stun.l.google.com:19302",
    ],
  },
];

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
}

export type FastInputMessage =
  | { t: "mm"; x: number; y: number }
  | { t: "wh"; dx: number; dy: number; x?: number; y?: number };

export type ControlClientMessage =
  | { t: "mm"; x: number; y: number }
  | { t: "wh"; dx: number; dy: number; x?: number; y?: number }
  | { t: "md"; x: number; y: number; b: 0 | 1 | 2; clicks?: number }
  | { t: "mu"; x: number; y: number; b: 0 | 1 | 2; clicks?: number }
  | { t: "kd"; code: string; meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }
  | { t: "ku"; code: string; meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }
  | { t: "txt"; text: string }
  | { t: "cb.set"; text: string }
  | { t: "cb.get" }
  | { t: "disp"; displayId: number }
  | { t: "qual"; quality: RdQuality }
  | { t: "idr" }
  | { t: "perm" }
  | { t: "ping"; ts: number };

export type ControlServerMessage =
  | { t: "pong"; ts: number }
  | { t: "state"; displays: RdDisplayInfo[]; activeDisplayId: number; permissions: RdPermissions; quality: RdQuality }
  | { t: "cb"; text: string };

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
