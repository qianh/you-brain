import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import {
  CLIPBOARD_CHUNK_CHARS,
  CLIPBOARD_MAX_CHARS,
  type ControlClientMessage,
  type ControlServerMessage,
  type FastInputMessage,
  type HostClipboardFile,
  type HostCursorShape,
} from "@you-brain/core/deck/remote-desktop/types.js";
import type {
  IceServerEntry,
  RdDisplayInfo,
  RdIceCandidate,
  RdOpenResult,
  RdPermissions,
  RdQuality,
} from "@you-brain/protocol";

import { Banner } from "../components/banner.js";
import { Button, IconButton } from "../components/button.js";
import { Icon } from "../components/icons.js";
import { Menu, type MenuItem } from "../components/menu.js";
import { Spinner } from "../components/spinner.js";
import { useOptionalToast } from "../components/toast.js";
import { useDaemon } from "../daemon-context.js";
import {
  ClickCounter,
  ClipboardAssembler,
  REMOTE_KEY_COMBOS,
  TrailingThrottle,
  applyZeroPlayoutDelay,
  chunkText,
  computeVideoContentBox,
  expandKeyCombo,
  extractModifiers,
  formatBitrate,
  isImeKeyEvent,
  isMacPlatform,
  mapDomMouseButton,
  mapKeyForRemote,
  normalizeVideoPoint,
  normalizeWheelDelta,
  summarizeRtcStats,
  type InboundVideoSample,
  type RemoteDesktopStatsView,
} from "../lib/remote-desktop-input.js";
import {
  RemoteFileClient,
  createBrowserDownloadSink,
  type DownloadSink,
  type TransferItem,
} from "../lib/remote-desktop-files.js";

const FALLBACK_ICE_SERVERS: IceServerEntry[] = [
  {
    urls: [
      "stun:stun.cloudflare.com:3478",
      "stun:stun.miwifi.com:3478",
      "stun:stun.qq.com:3478",
      "stun:stun.l.google.com:19302",
    ],
  },
];

const ICE_CONNECT_TIMEOUT_MS = 15_000;
/** ICE 断开后等待自愈的时间，超时即自动重连。 */
const ICE_DISCONNECT_GRACE_MS = 4_000;
const MAX_AUTO_RECONNECTS = 6;
/** 鼠标移动最小发送间隔（约 250Hz），间隔内只发最新位置并补发尾帧。 */
const MOVE_INTERVAL_MS = 4;
const WHEEL_FLUSH_MS = 8;
/** 声明本地光标后多久没收到光标形状，就判定远端不支持并回落画面内光标。 */
const CURSOR_SHAPE_TIMEOUT_MS = 1_500;
const COPY_WAIT_MS = 1_500;
const PASTE_FALLBACK_MS = 150;
const DEFAULT_DOUBLE_CLICK_MS = 500;
const CURSOR_MAX_CSS_PX = 128;

const PREF_PREFIX = "you-brain.rd.";

export type ConnectStage = "turn" | "signaling" | "ice";

type SessionStatus =
  | { kind: "connecting"; stage: ConnectStage }
  | { kind: "ready" }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "closed" }
  | { kind: "error"; reason: string };

type ScaleMode = "fit" | "actual";

export function generateRdSessionId(): string {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 10)}`;
  const clean = uuid.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
  return `rd-${clean.padEnd(8, "0")}`;
}

export function hasTurnIceServer(servers: readonly IceServerEntry[]): boolean {
  return servers.some((entry) =>
    entry.urls.some((url) => /^turns?:/iu.test(url.trim())),
  );
}

function isRdOpenResult(value: unknown): value is RdOpenResult {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" &&
    typeof record.answerSdp === "string" &&
    Array.isArray(record.displays) &&
    typeof record.activeDisplayId === "number" &&
    record.permissions !== null &&
    typeof record.permissions === "object"
  );
}

function preferH264Transceiver(transceiver: RTCRtpTransceiver): void {
  if (typeof transceiver.setCodecPreferences !== "function") return;
  if (typeof RTCRtpReceiver === "undefined" || typeof RTCRtpReceiver.getCapabilities !== "function") {
    return;
  }
  const caps = RTCRtpReceiver.getCapabilities("video");
  if (!caps?.codecs?.length) return;
  const h264 = caps.codecs.filter((codec) => codec.mimeType.toLowerCase() === "video/h264");
  if (h264.length === 0) return;
  const rest = caps.codecs.filter((codec) => codec.mimeType.toLowerCase() !== "video/h264");
  try {
    transceiver.setCodecPreferences([...h264, ...rest]);
  } catch {
    // 浏览器拒绝部分编解码器排序时回落默认协商。
  }
}

function readPref<T extends string | boolean>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(PREF_PREFIX + key);
    if (raw === null) return fallback;
    if (typeof fallback === "boolean") return (raw === "1") as T;
    return raw as T;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string | boolean): void {
  try {
    window.localStorage.setItem(PREF_PREFIX + key, typeof value === "boolean" ? (value ? "1" : "0") : value);
  } catch {
    // 无痕模式等场景忽略
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("cursor image"));
    img.src = src;
  });
}

/**
 * 把远端光标按画面缩放比例重绘成 CSS 光标。浏览器原生光标由系统合成，
 * 移动零延迟，彻底消除「光标跟手慢一个往返」的拖影感。
 */
async function buildCursorCss(shape: HostCursorShape, scale: number, dpr: number): Promise<string> {
  const img = await loadImage(`data:image/png;base64,${shape.png}`);
  const fit = Math.min(1, CURSOR_MAX_CSS_PX / Math.max(shape.w * scale, shape.h * scale, 1));
  const effective = scale * fit;
  const cssW = Math.max(1, Math.round(shape.w * effective));
  const cssH = Math.max(1, Math.round(shape.h * effective));
  const hx = Math.max(0, Math.min(cssW - 1, Math.round(shape.hx * effective)));
  const hy = Math.max(0, Math.min(cssH - 1, Math.round(shape.hy * effective)));
  const render = (factor: number): string => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(cssW * factor));
    canvas.height = Math.max(1, Math.round(cssH * factor));
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  };
  const base = render(1);
  if (!base) return "default";
  const ratio = Math.max(1, Math.min(3, Math.round(dpr * 2) / 2));
  if (ratio === 1) return `url("${base}") ${hx} ${hy}, default`;
  const hi = render(ratio);
  return `-webkit-image-set(url("${base}") 1x, url("${hi}") ${ratio}x) ${hx} ${hy}, default|url("${base}") ${hx} ${hy}, default`;
}

function applyCursorCss(el: HTMLElement, css: string): void {
  const [preferred, fallback] = css.split("|");
  if (fallback) el.style.cursor = fallback;
  // 不支持 image-set 的浏览器会忽略这次赋值，保留上面的 1x 回落值。
  if (preferred) el.style.cursor = preferred;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "CapsLock",
]);

const COMBO_LABEL_KEYS = {
  appSwitcher: "deckRdKeyAppSwitcher",
  spotlight: "deckRdKeySpotlight",
  inputSource: "deckRdKeyInputSource",
  missionControl: "deckRdKeyMissionControl",
  showDesktop: "deckRdKeyShowDesktop",
  forceQuit: "deckRdKeyForceQuit",
  lockScreen: "deckRdKeyLockScreen",
  screenshot: "deckRdKeyScreenshot",
  closeWindow: "deckRdKeyCloseWindow",
  quitApp: "deckRdKeyQuitApp",
  hideApp: "deckRdKeyHideApp",
} as const;

export interface DeckRemoteDesktopPaneProps {
  deviceId: string;
  deviceName: string;
  active: boolean;
  canBackToT3: boolean;
  reloadCount: number;
  onBackToT3?: () => void;
}

export function DeckRemoteDesktopPane({
  deviceId,
  deviceName,
  active,
  canBackToT3,
  reloadCount,
  onBackToT3,
}: DeckRemoteDesktopPaneProps) {
  const { client, t } = useDaemon();
  const toast = useOptionalToast();
  const push = useCallback(
    (options: { message: string; tone?: "info" | "success" | "warn" | "danger" }) => {
      toast?.push(options);
    },
    [toast],
  );

  const controllerIsMac = useMemo(
    () => isMacPlatform(typeof navigator === "undefined" ? undefined : navigator),
    [],
  );

  const [status, setStatus] = useState<SessionStatus>({ kind: "connecting", stage: "turn" });
  const [quality, setQuality] = useState<RdQuality>(() => readPref<RdQuality>("quality", "hd"));
  const [displays, setDisplays] = useState<RdDisplayInfo[]>([]);
  const [activeDisplayId, setActiveDisplayId] = useState<number>(0);
  const [permissions, setPermissions] = useState<RdPermissions>({
    screenRecording: true,
    accessibility: true,
  });
  const [pingRttMs, setPingRttMs] = useState<number | null>(null);
  const [stats, setStats] = useState<RemoteDesktopStatsView | null>(null);
  const [hostStats, setHostStats] = useState<{ bitrateBps: number; lossPct: number } | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [focused, setFocused] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [clipboardSync, setClipboardSync] = useState(() => readPref<boolean>("clipboardSync", true));
  const [localCursor, setLocalCursor] = useState(() => readPref<boolean>("localCursor", true));
  const [swapCtrlCmd, setSwapCtrlCmd] = useState(() => readPref<boolean>("swapCtrlCmd", !controllerIsMac));
  const [scaleMode, setScaleMode] = useState<ScaleMode>(() => readPref<ScaleMode>("scale", "fit"));
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [remoteFiles, setRemoteFiles] = useState<HostClipboardFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [composition, setComposition] = useState<string | null>(null);
  const [imeAnchor, setImeAnchor] = useState<{ x: number; y: number }>({ x: 24, y: 24 });
  const [videoSize, setVideoSizeState] = useState<{ w: number; h: number } | null>(null);
  const setVideoSize = useCallback((next: { w: number; h: number } | null) => {
    setVideoSizeState((prev) => {
      if (prev === next) return prev;
      if (prev && next && prev.w === next.w && prev.h === next.h) return prev;
      return next;
    });
  }, []);
  /** 远端光标是否画在视频里（本地光标不可用或已关闭）。 */
  const [cursorInVideo, setCursorInVideo] = useState(!localCursor);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imeRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fastDcRef = useRef<RTCDataChannel | null>(null);
  const controlDcRef = useRef<RTCDataChannel | null>(null);
  const fileClientRef = useRef<RemoteFileClient | null>(null);
  const onVideoMediaReadyRef = useRef<(() => void) | null>(null);
  const pressedButtonsRef = useRef(new Set<0 | 1 | 2>());
  const pressedKeysRef = useRef(new Set<string>());
  const composingRef = useRef(false);
  const statusRef = useRef<SessionStatus>(status);
  statusRef.current = status;
  const qualityRef = useRef<RdQuality>(quality);
  qualityRef.current = quality;
  const clipboardSyncRef = useRef(clipboardSync);
  clipboardSyncRef.current = clipboardSync;
  const localCursorRef = useRef(localCursor);
  localCursorRef.current = localCursor;
  const swapCtrlCmdRef = useRef(swapCtrlCmd);
  swapCtrlCmdRef.current = swapCtrlCmd;
  const doubleClickMsRef = useRef(DEFAULT_DOUBLE_CLICK_MS);
  const clickCounterRef = useRef(new ClickCounter());
  const clipboardAssemblerRef = useRef(new ClipboardAssembler());
  const cursorShapeRef = useRef<HostCursorShape | null>(null);
  const cursorCssKeyRef = useRef<string>("");
  const cursorReceivedRef = useRef(false);
  const pendingCopyRef = useRef<{ deferred: Deferred<string>; timer: ReturnType<typeof setTimeout> } | null>(null);
  const pendingRemoteClipRef = useRef<string | null>(null);
  const pendingPasteRef = useRef<{
    code: string;
    mods: ReturnType<typeof extractModifiers>;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const lastSyncedClipRef = useRef<string | null>(null);
  const autoReconnectRef = useRef(0);
  const fullscreenRequestedRef = useRef(false);
  const displaysRef = useRef<RdDisplayInfo[]>(displays);
  displaysRef.current = displays;
  const activeDisplayIdRef = useRef(activeDisplayId);
  activeDisplayIdRef.current = activeDisplayId;

  const sendFast = useCallback((msg: FastInputMessage) => {
    const dc = fastDcRef.current;
    if (!dc || dc.readyState !== "open") return;
    if (dc.bufferedAmount > 64 * 1024) return;
    try {
      dc.send(JSON.stringify(msg));
    } catch {
      // 高频通道瞬时发送失败可安全丢弃。
    }
  }, []);

  const sendControl = useCallback((msg: ControlClientMessage): boolean => {
    const dc = controlDcRef.current;
    if (!dc || dc.readyState !== "open") return false;
    try {
      dc.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }, []);

  const sendCfg = useCallback(() => {
    sendControl({
      t: "cfg",
      localCursor: localCursorRef.current && !cursorFallbackRef.current,
      clipboardSync: clipboardSyncRef.current,
    });
  }, [sendControl]);
  const cursorFallbackRef = useRef(false);

  const sendClipboardText = useCallback(
    (text: string): boolean => {
      const clipped = text.length > CLIPBOARD_MAX_CHARS ? text.slice(0, CLIPBOARD_MAX_CHARS) : text;
      const parts = chunkText(clipped, CLIPBOARD_CHUNK_CHARS);
      lastSyncedClipRef.current = clipped;
      if (parts.length === 1) return sendControl({ t: "cb.set", text: clipped });
      const id = generateRdSessionId().slice(3, 15);
      let ok = true;
      parts.forEach((part, i) => {
        ok = sendControl({ t: "cb.set", text: part, chunk: { id, i, n: parts.length } }) && ok;
      });
      return ok;
    },
    [sendControl],
  );

  const releaseAllKeys = useCallback(() => {
    const keys = [...pressedKeysRef.current];
    pressedKeysRef.current.clear();
    for (const code of keys) {
      sendControl({ t: "ku", code, meta: false, ctrl: false, alt: false, shift: false });
    }
    for (const btn of [...pressedButtonsRef.current]) {
      sendControl({ t: "mu", x: 0.5, y: 0.5, b: btn });
    }
    pressedButtonsRef.current.clear();
    if (pendingPasteRef.current) {
      clearTimeout(pendingPasteRef.current.timer);
      pendingPasteRef.current = null;
    }
  }, [sendControl]);

  /** 在用户手势里写本机剪贴板（Safari/WKWebView 只允许手势内写入）。 */
  const flushPendingRemoteClipboard = useCallback(() => {
    const text = pendingRemoteClipRef.current;
    if (text === null) return;
    pendingRemoteClipRef.current = null;
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  }, []);

  const writeLocalClipboard = useCallback(
    (text: string, notify: boolean) => {
      lastSyncedClipRef.current = text;
      const pendingCopy = pendingCopyRef.current;
      if (pendingCopy) {
        clearTimeout(pendingCopy.timer);
        pendingCopyRef.current = null;
        pendingCopy.deferred.resolve(text);
        if (notify) push({ message: t("deckRdClipboardPulled") });
        return;
      }
      const writer = navigator.clipboard?.writeText?.bind(navigator.clipboard);
      if (!writer) {
        push({ message: t("deckRdClipboardFailed"), tone: "danger" });
        return;
      }
      writer(text).then(
        () => {
          pendingRemoteClipRef.current = null;
          if (notify) push({ message: t("deckRdClipboardPulled") });
        },
        () => {
          // 不在手势里或页面没焦点：等下一次点击/按键时写入。
          const first = pendingRemoteClipRef.current === null;
          pendingRemoteClipRef.current = text;
          if (notify || first) push({ message: t("deckRdClipboardPending") });
        },
      );
    },
    [push, t],
  );

  const refreshCursor = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    if (cursorInVideoRef.current) {
      surface.style.cursor = "";
      return;
    }
    const shape = cursorShapeRef.current;
    if (!shape) {
      surface.style.cursor = "default";
      return;
    }
    const video = videoRef.current;
    const rect = surface.getBoundingClientRect();
    const box = computeVideoContentBox(rect.width, rect.height, video?.videoWidth ?? 0, video?.videoHeight ?? 0);
    const display =
      displaysRef.current.find((item) => item.id === activeDisplayIdRef.current) ?? displaysRef.current[0];
    const scale = display && display.width > 0 ? box.width / display.width : 1;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const key = `${shape.png.length}:${shape.png.slice(0, 64)}:${shape.png.slice(-64)}:${scale.toFixed(3)}:${dpr}`;
    if (key === cursorCssKeyRef.current) return;
    cursorCssKeyRef.current = key;
    void buildCursorCss(shape, scale, dpr).then(
      (css) => {
        if (cursorCssKeyRef.current !== key || cursorInVideoRef.current) return;
        applyCursorCss(surface, css);
      },
      () => undefined,
    );
  }, []);
  const cursorInVideoRef = useRef(cursorInVideo);
  cursorInVideoRef.current = cursorInVideo;
  const writeLocalClipboardRef = useRef(writeLocalClipboard);
  writeLocalClipboardRef.current = writeLocalClipboard;

  // 偏好持久化
  useEffect(() => writePref("clipboardSync", clipboardSync), [clipboardSync]);
  useEffect(() => writePref("localCursor", localCursor), [localCursor]);
  useEffect(() => writePref("swapCtrlCmd", swapCtrlCmd), [swapCtrlCmd]);
  useEffect(() => writePref("scale", scaleMode), [scaleMode]);
  useEffect(() => writePref("quality", quality), [quality]);

  // 能力声明随偏好变化重新下发
  useEffect(() => {
    if (!localCursor) {
      cursorFallbackRef.current = false;
      setCursorInVideo(true);
    } else if (!cursorFallbackRef.current) {
      setCursorInVideo(false);
    }
    sendCfg();
  }, [clipboardSync, localCursor, sendCfg]);

  useEffect(() => {
    cursorCssKeyRef.current = "";
    refreshCursor();
  }, [cursorInVideo, activeDisplayId, displays, videoSize, scaleMode, fullscreen, refreshCursor]);

  // 画面区域尺寸变化时按新比例重绘光标
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => refreshCursor());
    observer.observe(surface);
    return () => observer.disconnect();
  }, [refreshCursor]);

  // 全屏状态同步
  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement && fullscreenRequestedRef.current) {
        fullscreenRequestedRef.current = false;
        setFullscreen(false);
        const keyboard = (navigator as Navigator & { keyboard?: { unlock?: () => void } }).keyboard;
        keyboard?.unlock?.();
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  // 切走隐藏或失焦时释放按住的按键，防止卡键
  useEffect(() => {
    if (!active) {
      releaseAllKeys();
      setFocused(false);
    }
  }, [active, releaseAllKeys]);

  useEffect(() => {
    const onWindowBlur = () => releaseAllKeys();
    window.addEventListener("blur", onWindowBlur);
    return () => window.removeEventListener("blur", onWindowBlur);
  }, [releaseAllKeys]);

  // 主 WebRTC 会话生命周期：仅当面板处于激活态时维持连接，切走立即释放编码器开销
  useEffect(() => {
    if (!active) return;
    if (typeof client.dispatchSend !== "function") {
      setStatus({ kind: "error", reason: t("dshDeckUnavailable") });
      return;
    }

    let disposed = false;
    let sessionId = generateRdSessionId();
    let rdOpenReady = false;
    let remoteDescriptionReady = false;
    let settled = false;
    // 自动重连中的这一轮也视为「连上过」，失败时继续按退避重试。
    let everReady = autoReconnectRef.current > 0;
    let hasTurn = false;
    const remoteIceBuffer: RdIceCandidate[] = [];
    const localIceBuffer: RdIceCandidate[] = [];
    let localIceTimer: ReturnType<typeof setTimeout> | null = null;
    let iceTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cursorTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let statsTimer: ReturnType<typeof setInterval> | null = null;
    let statsSample: InboundVideoSample | null = null;
    const sseAbort = new AbortController();

    if (autoReconnectRef.current === 0) {
      setStatus({ kind: "connecting", stage: "turn" });
    }
    setPingRttMs(null);
    setStats(null);
    setHostStats(null);
    setVideoSize(null);
    cursorReceivedRef.current = false;
    clickCounterRef.current.reset();

    let pc: RTCPeerConnection | null = null;

    const clearIceTimeout = () => {
      if (iceTimeoutTimer !== null) {
        clearTimeout(iceTimeoutTimer);
        iceTimeoutTimer = null;
      }
    };

    const clearDisconnectTimer = () => {
      if (disconnectTimer !== null) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
    };

    const iceFailedReason = () =>
      hasTurn ? t("deckRdIceFailedWithTurn") : t("deckRdIceFailedNoTurn");

    const sendCloseIfOpened = () => {
      if (!rdOpenReady || typeof client.dispatchSend !== "function") return;
      rdOpenReady = false;
      const closingId = sessionId;
      void client
        .dispatchSend({
          to: deviceId,
          kind: "rd.close",
          args: { sessionId: closingId },
        })
        .catch(() => undefined);
    };

    const markReady = () => {
      if (disposed || settled) return;
      settled = true;
      everReady = true;
      autoReconnectRef.current = 0;
      clearIceTimeout();
      setStatus({ kind: "ready" });
    };

    const teardownPc = () => {
      if (pc) {
        try {
          pc.close();
        } catch {
          // ignore
        }
      }
    };

    /** 已经连上过的会话因网络或宿主进程中断时，按退避自动重连。 */
    const scheduleReconnect = (reason: string): boolean => {
      if (disposed || !everReady) return false;
      const attempt = autoReconnectRef.current + 1;
      if (attempt > MAX_AUTO_RECONNECTS) {
        autoReconnectRef.current = 0;
        return false;
      }
      autoReconnectRef.current = attempt;
      settled = true;
      clearIceTimeout();
      clearDisconnectTimer();
      teardownPc();
      sendCloseIfOpened();
      setStatus({ kind: "reconnecting", attempt });
      const delay = Math.min(8_000, 500 * 2 ** (attempt - 1));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!disposed) setReconnectNonce((n) => n + 1);
      }, delay);
      void reason;
      return true;
    };

    const failWith = (reason: string, retryable = false) => {
      if (disposed || settled) return;
      if ((retryable || autoReconnectRef.current > 0) && scheduleReconnect(reason)) return;
      settled = true;
      autoReconnectRef.current = 0;
      clearIceTimeout();
      clearDisconnectTimer();
      setStatus({ kind: "error", reason });
      teardownPc();
      sendCloseIfOpened();
    };

    const connectionLost = (reason: string) => {
      if (disposed) return;
      if (everReady) {
        // ready 之后 settled 已为 true，这里直接走重连。
        if (scheduleReconnect(reason)) return;
        setStatus({ kind: "error", reason });
        teardownPc();
        sendCloseIfOpened();
        return;
      }
      failWith(reason);
    };

    onVideoMediaReadyRef.current = markReady;

    const flushLocalIce = () => {
      if (localIceTimer !== null) {
        clearTimeout(localIceTimer);
        localIceTimer = null;
      }
      if (disposed || !remoteDescriptionReady || localIceBuffer.length === 0) return;
      const batch = localIceBuffer.splice(0, 32);
      void client
        .dispatchSend!({
          to: deviceId,
          kind: "rd.ice",
          args: { sessionId, candidates: batch },
        })
        .catch(() => undefined);
      if (localIceBuffer.length > 0) {
        localIceTimer = setTimeout(flushLocalIce, 15);
      }
    };

    const enqueueLocalIce = (candidate: RdIceCandidate) => {
      if (disposed) return;
      localIceBuffer.push(candidate);
      if (!remoteDescriptionReady) return;
      if (localIceBuffer.length >= 24) {
        flushLocalIce();
      } else if (localIceTimer === null) {
        localIceTimer = setTimeout(flushLocalIce, 15);
      }
    };

    const applyRemoteCandidate = (cand: RdIceCandidate) => {
      if (!pc || disposed) return;
      if (!cand.candidate) {
        void pc.addIceCandidate(null).catch(() => undefined);
        return;
      }
      void pc
        .addIceCandidate({
          candidate: cand.candidate,
          sdpMid: cand.sdpMid ?? null,
          sdpMLineIndex: cand.sdpMLineIndex ?? null,
          usernameFragment: cand.usernameFragment ?? null,
        })
        .catch(() => undefined);
    };

    const onServerMessage = (msg: ControlServerMessage) => {
      switch (msg.t) {
        case "state":
          setDisplays(msg.displays);
          setActiveDisplayId(msg.activeDisplayId);
          setPermissions(msg.permissions);
          if (typeof msg.doubleClickMs === "number" && msg.doubleClickMs > 0) {
            doubleClickMsRef.current = msg.doubleClickMs;
          }
          return;
        case "pong": {
          const delta = Math.max(0, Math.round(performance.now()) - msg.ts);
          if (delta < 30_000) setPingRttMs(delta);
          return;
        }
        case "cb": {
          const text = clipboardAssemblerRef.current.push(msg);
          if (text === null) return;
          if (msg.auto) {
            if (!clipboardSyncRef.current || text === lastSyncedClipRef.current) return;
            writeLocalClipboardRef.current(text, false);
          } else {
            writeLocalClipboardRef.current(text, true);
          }
          return;
        }
        case "cb.files":
          setRemoteFiles(msg.files);
          return;
        case "cursor": {
          cursorReceivedRef.current = true;
          if (cursorTimer !== null) {
            clearTimeout(cursorTimer);
            cursorTimer = null;
          }
          cursorShapeRef.current = { png: msg.png, hx: msg.hx, hy: msg.hy, w: msg.w, h: msg.h };
          refreshCursor();
          return;
        }
        case "stats":
          setHostStats({ bitrateBps: msg.bitrateBps, lossPct: msg.lossPct });
          return;
        default:
          return;
      }
    };

    // 先订阅 SSE，确保不漏掉 answer 返回前后的任何增量 ICE / 状态帧
    if (typeof client.dispatchRdEvents === "function") {
      void client
        .dispatchRdEvents(
          (event) => {
            if (disposed || event.from !== deviceId) return;
            if (event.kind === "rd.ice") {
              if (event.data.sessionId !== sessionId) return;
              for (const item of event.data.candidates) {
                if (!remoteDescriptionReady) {
                  remoteIceBuffer.push(item);
                } else {
                  applyRemoteCandidate(item);
                }
              }
              return;
            }
            if (event.kind === "rd.state") {
              if (event.data.sessionId !== sessionId) return;
              if (event.data.displays) setDisplays(event.data.displays);
              if (event.data.activeDisplayId !== undefined) {
                setActiveDisplayId(event.data.activeDisplayId);
              }
              if (event.data.permissions) setPermissions(event.data.permissions);
              if (event.data.state === "closed") {
                rdOpenReady = false;
                const error = event.data.error ?? "";
                // 宿主进程崩溃可自动恢复；被抢占、空闲超时、对端关闭则停在已断开。
                if (error.includes("异常退出") && scheduleReconnect(error)) return;
                settled = true;
                clearIceTimeout();
                autoReconnectRef.current = 0;
                setStatus({ kind: "closed" });
              } else if (event.data.state === "error") {
                failWith(event.data.error || t("dshDeckT3CheckError"));
              }
            }
          },
          { signal: sseAbort.signal },
        )
        .catch(() => undefined);
    }

    const collectStats = async () => {
      if (!pc || disposed) return;
      try {
        const report = await pc.getStats();
        if (disposed) return;
        const entries = [...(report as unknown as Map<string, Record<string, unknown>>).values()];
        const { view, sample } = summarizeRtcStats(entries, statsSample, performance.now());
        statsSample = sample;
        setStats(view);
        if (view.width && view.height) setVideoSize({ w: view.width, h: view.height });
      } catch {
        // 统计失败不影响会话
      }
    };

    const start = async () => {
      let iceServers: IceServerEntry[] = FALLBACK_ICE_SERVERS;
      if (typeof client.dispatchTurn === "function") {
        try {
          const turn = await client.dispatchTurn();
          if (turn.iceServers.length > 0) iceServers = turn.iceServers;
        } catch {
          // 回落公共 STUN
        }
      }
      if (disposed) return;
      hasTurn = hasTurnIceServer(iceServers);

      pc = new RTCPeerConnection({
        iceServers: iceServers.map((entry) => ({
          urls: entry.urls,
          ...(entry.username !== undefined ? { username: entry.username } : {}),
          ...(entry.credential !== undefined ? { credential: entry.credential } : {}),
        })),
        bundlePolicy: "max-bundle",
      });

      const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
      preferH264Transceiver(transceiver);
      applyZeroPlayoutDelay(transceiver.receiver);

      const fastDc = pc.createDataChannel("input-fast", {
        ordered: false,
        maxRetransmits: 0,
      });
      const controlDc = pc.createDataChannel("control", {
        ordered: true,
      });
      const fileDc = pc.createDataChannel("file", { ordered: true });
      fastDcRef.current = fastDc;
      controlDcRef.current = controlDc;

      const downloadSink: DownloadSink =
        typeof window !== "undefined" && window.__TAURI__ && typeof client.dispatchRdSave === "function"
          ? async ({ token, name, offset, chunk, final }) => {
              const saved = await client.dispatchRdSave!({ token, name, offset, final }, chunk);
              return final ? saved.path : undefined;
            }
          : createBrowserDownloadSink();
      const fileClient = new RemoteFileClient(fileDc as unknown as ConstructorParameters<typeof RemoteFileClient>[0], {
        onUpdate: (items) => {
          if (!disposed) setTransfers(items);
        },
        sink: downloadSink,
      });
      fileClientRef.current = fileClient;

      const onControlOpen = () => {
        if (disposed) return;
        markReady();
        sendCfg();
        sendControl({ t: "ping", ts: Math.round(performance.now()) });
        if (pingTimer === null) {
          pingTimer = setInterval(() => {
            sendControl({ t: "ping", ts: Math.round(performance.now()) });
          }, 2_000);
        }
        if (statsTimer === null) {
          statsTimer = setInterval(() => void collectStats(), 1_000);
        }
        // 远端不上报光标形状（旧版宿主或采集失败）时回落到画面内光标。
        if (localCursorRef.current && !cursorReceivedRef.current) {
          cursorTimer = setTimeout(() => {
            cursorTimer = null;
            if (disposed || cursorReceivedRef.current || !localCursorRef.current) return;
            cursorFallbackRef.current = true;
            setCursorInVideo(true);
            sendCfg();
          }, CURSOR_SHAPE_TIMEOUT_MS);
        }
      };
      if (controlDc.readyState === "open") {
        onControlOpen();
      } else {
        controlDc.addEventListener("open", onControlOpen);
      }

      controlDc.addEventListener("message", (ev) => {
        if (disposed || typeof ev.data !== "string") return;
        let msg: ControlServerMessage;
        try {
          msg = JSON.parse(ev.data) as ControlServerMessage;
        } catch {
          return;
        }
        onServerMessage(msg);
      });

      pc.addEventListener("track", (ev) => {
        if (disposed) return;
        applyZeroPlayoutDelay(ev.receiver);
        for (const receiver of pc?.getReceivers() ?? []) {
          applyZeroPlayoutDelay(receiver);
        }
        const video = videoRef.current;
        if (!video) return;
        const stream = ev.streams[0] ?? new MediaStream([ev.track]);
        if (video.srcObject !== stream) {
          video.srcObject = stream;
        }
        void video.play().catch(() => undefined);
      });

      pc.addEventListener("icecandidate", (ev) => {
        if (disposed) return;
        if (!ev.candidate || !ev.candidate.candidate) {
          enqueueLocalIce({ candidate: "" });
          return;
        }
        enqueueLocalIce({
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
          usernameFragment: ev.candidate.usernameFragment,
        });
      });

      pc.addEventListener("iceconnectionstatechange", () => {
        if (disposed || !pc) return;
        const iceState = pc.iceConnectionState;
        if (iceState === "connected" || iceState === "completed") {
          clearDisconnectTimer();
          for (const receiver of pc.getReceivers()) applyZeroPlayoutDelay(receiver);
          markReady();
        } else if (iceState === "failed") {
          connectionLost(iceFailedReason());
        } else if (iceState === "disconnected" && everReady && disconnectTimer === null) {
          disconnectTimer = setTimeout(() => {
            disconnectTimer = null;
            if (!disposed && pc && pc.iceConnectionState !== "connected" && pc.iceConnectionState !== "completed") {
              connectionLost(iceFailedReason());
            }
          }, ICE_DISCONNECT_GRACE_MS);
        }
      });

      pc.addEventListener("connectionstatechange", () => {
        if (disposed || !pc) return;
        if (pc.connectionState === "connected") {
          for (const receiver of pc.getReceivers()) applyZeroPlayoutDelay(receiver);
          markReady();
        } else if (pc.connectionState === "failed") {
          connectionLost(iceFailedReason());
        } else if (pc.connectionState === "closed" && everReady) {
          connectionLost(t("deckRdClosed"));
        }
      });

      const offer = await pc.createOffer();
      if (disposed) return;
      await pc.setLocalDescription(offer);
      if (disposed) return;

      if (autoReconnectRef.current === 0) {
        setStatus({ kind: "connecting", stage: "signaling" });
      }
      const outcome = await client.dispatchSend!({
        to: deviceId,
        kind: "rd.open",
        args: {
          sessionId,
          offerSdp: pc.localDescription?.sdp ?? offer.sdp ?? "",
          quality: qualityRef.current,
        },
      });
      if (disposed) {
        if (outcome.ok && isRdOpenResult(outcome.result)) {
          void client
            .dispatchSend!({
              to: deviceId,
              kind: "rd.close",
              args: { sessionId: outcome.result.sessionId },
            })
            .catch(() => undefined);
        }
        return;
      }
      if (!outcome.ok) {
        failWith(outcome.error);
        return;
      }
      if (!isRdOpenResult(outcome.result)) {
        failWith("远端返回了无效的桌面会话应答");
        return;
      }

      sessionId = outcome.result.sessionId;
      rdOpenReady = true;
      setDisplays(outcome.result.displays);
      setActiveDisplayId(outcome.result.activeDisplayId);
      setPermissions(outcome.result.permissions);

      await pc.setRemoteDescription({
        type: "answer",
        sdp: outcome.result.answerSdp,
      });
      if (disposed) return;
      remoteDescriptionReady = true;
      if (!settled && autoReconnectRef.current === 0) {
        setStatus({ kind: "connecting", stage: "ice" });
      }

      while (remoteIceBuffer.length > 0) {
        const next = remoteIceBuffer.shift();
        if (next) applyRemoteCandidate(next);
      }
      flushLocalIce();

      if (!settled) {
        iceTimeoutTimer = setTimeout(() => {
          failWith(iceFailedReason());
        }, ICE_CONNECT_TIMEOUT_MS);
      }
    };

    void start().catch((error: unknown) => {
      if (disposed) return;
      failWith(error instanceof Error ? error.message : String(error));
    });

    return () => {
      disposed = true;
      onVideoMediaReadyRef.current = null;
      sseAbort.abort();
      clearIceTimeout();
      clearDisconnectTimer();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (cursorTimer !== null) clearTimeout(cursorTimer);
      if (localIceTimer !== null) clearTimeout(localIceTimer);
      if (pingTimer !== null) clearInterval(pingTimer);
      if (statsTimer !== null) clearInterval(statsTimer);
      fileClientRef.current?.dispose();
      fileClientRef.current = null;
      fastDcRef.current = null;
      controlDcRef.current = null;
      const pendingCopy = pendingCopyRef.current;
      if (pendingCopy) {
        clearTimeout(pendingCopy.timer);
        pendingCopy.deferred.reject(new Error("closed"));
        pendingCopyRef.current = null;
      }
      const video = videoRef.current;
      if (video) video.srcObject = null;
      teardownPc();
      sendCloseIfOpened();
    };
  }, [active, client, deviceId, reconnectNonce, reloadCount, sendCfg, sendControl, refreshCursor, setVideoSize, t]);

  // 离开面板时重置自动重连计数，避免下次进入沿用旧的退避状态
  useEffect(() => {
    if (!active) autoReconnectRef.current = 0;
  }, [active]);

  const pointFromClient = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const surface = surfaceRef.current;
    const video = videoRef.current;
    if (!surface) return { x: 0.5, y: 0.5 };
    const rect = surface.getBoundingClientRect();
    const box = computeVideoContentBox(rect.width, rect.height, video?.videoWidth ?? 0, video?.videoHeight ?? 0);
    return normalizeVideoPoint(clientX - rect.left, clientY - rect.top, box);
  }, []);

  const focusInput = useCallback(() => {
    const ime = imeRef.current;
    if (ime && document.activeElement !== ime) ime.focus({ preventScroll: true });
  }, []);

  // 指针与滚轮：原生监听，优先 pointerrawupdate（不受帧率限制）并做 4ms 节流 + 尾帧补发
  useEffect(() => {
    const surface = surfaceRef.current;
    const stage = stageRef.current;
    if (!surface || !stage) return;
    const ready = () => statusRef.current.kind === "ready";

    const moveThrottle = new TrailingThrottle<FastInputMessage>(MOVE_INTERVAL_MS, (msg) => sendFast(msg));
    const supportsRaw = "onpointerrawupdate" in surface;

    const onMove = (event: PointerEvent) => {
      if (!ready()) return;
      const pt = pointFromClient(event.clientX, event.clientY);
      moveThrottle.push({ t: "mm", x: pt.x, y: pt.y });
    };

    const onDown = (event: PointerEvent) => {
      focusInput();
      flushPendingRemoteClipboard();
      const stageRect = stage.getBoundingClientRect();
      setImeAnchor({
        x: Math.max(4, Math.min(stageRect.width - 8, event.clientX - stageRect.left)),
        y: Math.max(24, Math.min(stageRect.height - 4, event.clientY - stageRect.top)),
      });
      if (!ready()) return;
      const btn = mapDomMouseButton(event.button);
      if (btn === null) return;
      event.preventDefault();
      try {
        surface.setPointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      moveThrottle.flush();
      const pt = pointFromClient(event.clientX, event.clientY);
      const clicks = clickCounterRef.current.register(
        btn,
        event.clientX,
        event.clientY,
        performance.now(),
        doubleClickMsRef.current,
      );
      pressedButtonsRef.current.add(btn);
      sendControl({ t: "md", x: pt.x, y: pt.y, b: btn, clicks });
    };

    const onUp = (event: PointerEvent) => {
      if (!ready()) return;
      const btn = mapDomMouseButton(event.button);
      if (btn === null || !pressedButtonsRef.current.has(btn)) return;
      event.preventDefault();
      try {
        if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      moveThrottle.flush();
      const pt = pointFromClient(event.clientX, event.clientY);
      pressedButtonsRef.current.delete(btn);
      sendControl({ t: "mu", x: pt.x, y: pt.y, b: btn, clicks: clickCounterRef.current.current });
    };

    const onCancel = () => {
      if (pressedButtonsRef.current.size === 0) return;
      for (const btn of [...pressedButtonsRef.current]) {
        sendControl({ t: "mu", x: 0.5, y: 0.5, b: btn });
      }
      pressedButtonsRef.current.clear();
    };

    let wheelDx = 0;
    let wheelDy = 0;
    let wheelPt: { x: number; y: number } | null = null;
    let wheelTimer: ReturnType<typeof setTimeout> | null = null;
    const flushWheel = () => {
      wheelTimer = null;
      if ((wheelDx === 0 && wheelDy === 0) || !wheelPt) return;
      sendFast({ t: "wh", x: wheelPt.x, y: wheelPt.y, dx: Math.round(wheelDx * 100) / 100, dy: Math.round(wheelDy * 100) / 100 });
      wheelDx = 0;
      wheelDy = 0;
    };
    const onWheel = (event: WheelEvent) => {
      if (!ready()) return;
      event.preventDefault();
      const { dx, dy } = normalizeWheelDelta(event.deltaX, event.deltaY, event.deltaMode);
      if (dx === 0 && dy === 0) return;
      wheelDx += dx;
      wheelDy += dy;
      wheelPt = pointFromClient(event.clientX, event.clientY);
      if (wheelTimer === null) wheelTimer = setTimeout(flushWheel, WHEEL_FLUSH_MS);
    };

    const onContextMenu = (event: Event) => event.preventDefault();

    const moveEvent = supportsRaw ? "pointerrawupdate" : "pointermove";
    surface.addEventListener(moveEvent, onMove as EventListener);
    surface.addEventListener("pointerdown", onDown);
    surface.addEventListener("pointerup", onUp);
    surface.addEventListener("pointercancel", onCancel);
    surface.addEventListener("lostpointercapture", onCancel);
    surface.addEventListener("wheel", onWheel, { passive: false });
    surface.addEventListener("contextmenu", onContextMenu);
    return () => {
      moveThrottle.cancel();
      if (wheelTimer !== null) clearTimeout(wheelTimer);
      surface.removeEventListener(moveEvent, onMove as EventListener);
      surface.removeEventListener("pointerdown", onDown);
      surface.removeEventListener("pointerup", onUp);
      surface.removeEventListener("pointercancel", onCancel);
      surface.removeEventListener("lostpointercapture", onCancel);
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("contextmenu", onContextMenu);
    };
  }, [flushPendingRemoteClipboard, focusInput, pointFromClient, sendControl, sendFast]);

  const localPrimary = (event: { metaKey: boolean; ctrlKey: boolean }) =>
    controllerIsMac ? event.metaKey : event.ctrlKey;

  const sendKeyDown = (code: string, mods: ReturnType<typeof extractModifiers>, repeat: boolean) => {
    pressedKeysRef.current.add(code);
    sendControl({ t: "kd", code, ...mods, ...(repeat ? { rep: true } : {}) });
  };

  const sendPasteKeystroke = (code: string, mods: ReturnType<typeof extractModifiers>) => {
    sendControl({ t: "kd", code, ...mods });
    sendControl({ t: "ku", code, ...mods });
  };

  /** 只有本机输入法或粘贴写进隐藏输入框的文字才走文本注入；物理按键都已拦截。 */
  const flushImeText = () => {
    const ime = imeRef.current;
    if (!ime || composingRef.current) return;
    const value = ime.value;
    if (!value) return;
    ime.value = "";
    if (statusRef.current.kind === "ready") sendControl({ t: "txt", text: value });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (statusRef.current.kind !== "ready") return;
    flushPendingRemoteClipboard();
    const native = event.nativeEvent;
    if (composingRef.current || isImeKeyEvent(native)) return;
    const code = event.code;
    if (!code) return;
    const mapped = mapKeyForRemote(code, extractModifiers(event), swapCtrlCmdRef.current);

    // ⌘V / Ctrl+V：放行浏览器粘贴事件，先把本机剪贴板写到远端，再按下远端粘贴键。
    if (clipboardSyncRef.current && localPrimary(event) && code === "KeyV" && !event.altKey) {
      if (pendingPasteRef.current) clearTimeout(pendingPasteRef.current.timer);
      const timer = setTimeout(() => {
        const pending = pendingPasteRef.current;
        pendingPasteRef.current = null;
        if (pending) sendPasteKeystroke(pending.code, pending.mods);
      }, PASTE_FALLBACK_MS);
      pendingPasteRef.current = { code: mapped.code, mods: mapped.mods, timer };
      return;
    }

    // ⌘C / ⌘X：在手势内预留一次剪贴板写入，远端复制结果回来后直接填入（Safari 只认手势内写入）。
    if (
      clipboardSyncRef.current &&
      localPrimary(event) &&
      (code === "KeyC" || code === "KeyX") &&
      !event.altKey &&
      !event.repeat &&
      typeof ClipboardItem !== "undefined" &&
      typeof navigator.clipboard?.write === "function"
    ) {
      const previous = pendingCopyRef.current;
      if (previous) {
        clearTimeout(previous.timer);
        previous.deferred.reject(new Error("superseded"));
      }
      const wait = deferred<string>();
      const timer = setTimeout(() => {
        if (pendingCopyRef.current?.deferred === wait) pendingCopyRef.current = null;
        wait.reject(new Error("timeout"));
      }, COPY_WAIT_MS);
      pendingCopyRef.current = { deferred: wait, timer };
      try {
        void navigator.clipboard
          .write([
            new ClipboardItem({
              "text/plain": wait.promise.then((text) => new Blob([text], { type: "text/plain" })),
            }),
          ])
          .catch(() => undefined);
      } catch {
        clearTimeout(timer);
        pendingCopyRef.current = null;
      }
    }

    event.preventDefault();
    event.stopPropagation();
    sendKeyDown(mapped.code, mapped.mods, event.repeat);
  };

  const handleKeyUp = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (statusRef.current.kind !== "ready") return;
    const code = event.code;
    if (!code) return;
    const mapped = mapKeyForRemote(code, extractModifiers(event), swapCtrlCmdRef.current);
    const wasPressed = pressedKeysRef.current.delete(mapped.code);
    if (!wasPressed && !(MODIFIER_CODES.has(mapped.code) && !composingRef.current)) return;
    event.preventDefault();
    event.stopPropagation();
    sendControl({ t: "ku", code: mapped.code, ...mapped.mods });
  };

  const handlePaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    const pending = pendingPasteRef.current;
    if (pending) {
      clearTimeout(pending.timer);
      pendingPasteRef.current = null;
    }
    if (statusRef.current.kind !== "ready") return;
    const data = event.clipboardData;
    const files = data ? [...data.files] : [];
    if (files.length > 0 && fileClientRef.current) {
      fileClientRef.current.upload(files);
      push({ message: t("deckRdUploadPasted", { count: files.length }) });
      return;
    }
    const text = data?.getData("text/plain") ?? "";
    if (text) sendClipboardText(text);
    if (pending) {
      sendPasteKeystroke(pending.code, pending.mods);
    } else if (text) {
      // 非快捷键触发的粘贴（如右键菜单）：直接注入文字。
      sendControl({ t: "txt", text: text.slice(0, 65_536) });
    }
  };

  const switchDisplay = (displayId: number) => {
    setActiveDisplayId(displayId);
    sendControl({ t: "disp", displayId });
  };

  const switchQuality = (next: RdQuality) => {
    setQuality(next);
    sendControl({ t: "qual", quality: next });
  };

  const pullClipboard = () => {
    sendControl({ t: "cb.get" });
  };

  const pushClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (sendClipboardText(text)) {
        push({ message: t("deckRdClipboardSent") });
      }
    } catch {
      push({ message: t("deckRdClipboardFailed"), tone: "danger" });
    }
  };

  // 本机已授权读剪贴板（Chromium）时，聚焦画面即把本机新复制的内容同步到远端，右键粘贴也能用。
  const syncLocalClipboardOnFocus = useCallback(async () => {
    if (!clipboardSyncRef.current || statusRef.current.kind !== "ready") return;
    try {
      const query = navigator.permissions?.query;
      if (!query) return;
      const state = await query.call(navigator.permissions, { name: "clipboard-read" as PermissionName });
      if (state.state !== "granted") return;
      const text = await navigator.clipboard.readText();
      if (text && text !== lastSyncedClipRef.current) sendClipboardText(text);
    } catch {
      // Safari 等不支持查询剪贴板权限时跳过
    }
  }, [sendClipboardText]);

  const sendCombo = (codes: readonly string[]) => {
    for (const step of expandKeyCombo(codes)) {
      sendControl(step);
    }
    focusInput();
  };

  const toggleFullscreen = async () => {
    if (fullscreen) {
      setFullscreen(false);
      if (document.fullscreenElement && fullscreenRequestedRef.current) {
        fullscreenRequestedRef.current = false;
        await document.exitFullscreen().catch(() => undefined);
      }
      const keyboard = (navigator as Navigator & { keyboard?: { unlock?: () => void } }).keyboard;
      keyboard?.unlock?.();
      return;
    }
    // 先铺满窗口；浏览器支持时再进入系统全屏并锁定键盘，⌘Tab 之外的系统快捷键也能发给远端。
    setFullscreen(true);
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        fullscreenRequestedRef.current = true;
        await document.documentElement.requestFullscreen();
        const keyboard = (navigator as Navigator & { keyboard?: { lock?: () => Promise<void> } }).keyboard;
        await keyboard?.lock?.().catch(() => undefined);
      }
    } catch {
      fullscreenRequestedRef.current = false;
    }
    focusInput();
  };

  const uploadFiles = (files: FileList | File[] | null) => {
    if (!files || !fileClientRef.current) return;
    const list = [...files];
    if (list.length > 0) fileClientRef.current.upload(list);
  };

  const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!dragOver) setDragOver(true);
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    setDragOver(false);
    uploadFiles(event.dataTransfer.files);
  };

  const rttMs = stats?.rttMs ?? pingRttMs;
  const lossPct = stats?.lossPct ?? hostStats?.lossPct ?? null;
  const healthClass =
    (rttMs !== null && rttMs > 200) || (lossPct !== null && lossPct > 8)
      ? "is-bad"
      : (rttMs !== null && rttMs > 80) || (lossPct !== null && lossPct > 2)
        ? "is-warn"
        : "";

  const activeDisplay = displays.find((item) => item.id === activeDisplayId) ?? displays[0];
  const surfaceStyle =
    scaleMode === "actual" && activeDisplay
      ? { width: `${activeDisplay.width}px`, height: `${activeDisplay.height}px` }
      : undefined;

  const check = (on: boolean) =>
    on ? <Icon name="check" size={13} /> : <span style={{ display: "inline-block", width: 13 }} />;

  const keyItems: MenuItem[] = REMOTE_KEY_COMBOS.map((combo) => ({
    id: combo.id,
    label: t(COMBO_LABEL_KEYS[combo.id as keyof typeof COMBO_LABEL_KEYS]),
    onSelect: () => sendCombo(combo.codes),
  }));

  const settingItems: MenuItem[] = [
    {
      id: "clipboardSync",
      label: t("deckRdClipboardAuto"),
      icon: check(clipboardSync),
      onSelect: () => {
        const next = !clipboardSync;
        setClipboardSync(next);
        push({ message: next ? t("deckRdClipboardAutoOn") : t("deckRdClipboardAutoOff") });
      },
    },
    { id: "localCursor", label: t("deckRdLocalCursor"), icon: check(localCursor), onSelect: () => setLocalCursor(!localCursor) },
    { id: "swapCtrlCmd", label: t("deckRdSwapCtrlCmd"), icon: check(swapCtrlCmd), onSelect: () => setSwapCtrlCmd(!swapCtrlCmd) },
    { id: "sep-1", separator: true },
    { id: "scaleFit", label: t("deckRdScaleFit"), icon: check(scaleMode === "fit"), onSelect: () => setScaleMode("fit") },
    { id: "scaleActual", label: t("deckRdScaleActual"), icon: check(scaleMode === "actual"), onSelect: () => setScaleMode("actual") },
    { id: "sep-2", separator: true },
    { id: "pull", label: t("deckRdSyncFromRemote"), icon: check(false), onSelect: pullClipboard },
    { id: "push", label: t("deckRdSyncToRemote"), icon: check(false), onSelect: () => void pushClipboard() },
    { id: "stats", label: t("deckRdStats"), icon: check(showStats), onSelect: () => setShowStats(!showStats) },
  ];

  const showTransfers = transfers.length > 0 || remoteFiles.length > 0;
  const isConnecting = status.kind === "connecting" || status.kind === "reconnecting";

  return (
    <div
      ref={rootRef}
      className={["deck-rd-root", fullscreen ? "is-fullscreen" : ""].filter(Boolean).join(" ")}
      hidden={!active}
    >
      <div className="deck-rd-toolbar">
        <div className="deck-rd-toolbar-left">
          {canBackToT3 && onBackToT3 && !fullscreen ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<Icon name="chevron-left" size={14} />}
              onClick={onBackToT3}
            >
              {t("deckRdBackToT3")}
            </Button>
          ) : null}
          <span className="deck-rd-device-pill">
            <Icon name="monitor" size={13} />
            <span>{deviceName}</span>
          </span>
          {status.kind === "ready" ? (
            <button
              type="button"
              className={["deck-rd-telemetry", "deck-rd-telemetry-btn", healthClass].filter(Boolean).join(" ")}
              aria-live="polite"
              title={t("deckRdStats")}
              onClick={() => setShowStats((value) => !value)}
            >
              <span className="deck-rd-dot is-live" />
              {rttMs !== null ? <span>{rttMs} ms</span> : null}
              <span>{stats?.fps ?? 60} fps</span>
              {stats?.bitrateBps ? <span>{formatBitrate(stats.bitrateBps)}</span> : null}
              {stats?.relay ? <span>{t("deckRdStatsPathRelay")}</span> : null}
            </button>
          ) : null}
          {status.kind === "ready" ? (
            <span className={["deck-rd-focus-pill", focused ? "is-focused" : ""].filter(Boolean).join(" ")}>
              {focused ? t("deckRdInputActive") : t("deckRdFocusHint")}
            </span>
          ) : null}
        </div>

        <div className="deck-rd-toolbar-right">
          {displays.length > 1 ? (
            <div className="deck-rd-segmented" role="group" aria-label="Displays">
              {displays.map((disp, idx) => (
                <button
                  key={disp.id}
                  type="button"
                  className={["deck-rd-seg-btn", disp.id === activeDisplayId ? "is-active" : ""].filter(Boolean).join(" ")}
                  onClick={() => switchDisplay(disp.id)}
                  title={`${disp.name} (${disp.width}×${disp.height})`}
                >
                  {t("deckRdDisplayLabel", { index: idx + 1 })}
                </button>
              ))}
            </div>
          ) : null}

          <div className="deck-rd-segmented" role="group" aria-label="Quality">
            {(["smooth", "hd", "ultra"] as const).map((preset) => (
              <button
                key={preset}
                type="button"
                className={["deck-rd-seg-btn", quality === preset ? "is-active" : ""].filter(Boolean).join(" ")}
                onClick={() => switchQuality(preset)}
              >
                {preset === "smooth"
                  ? t("deckRdQualitySmooth")
                  : preset === "hd"
                    ? t("deckRdQualityHd")
                    : t("deckRdQualityUltra")}
              </button>
            ))}
          </div>

          <Menu
            label={t("deckRdKeys")}
            items={keyItems}
            trigger={
              <Button size="sm" variant="ghost" icon={<Icon name="command" size={14} />}>
                {t("deckRdKeys")}
              </Button>
            }
          />

          <IconButton label={t("deckRdUpload")} onClick={() => fileInputRef.current?.click()}>
            <Icon name="arrow-up" size={14} />
          </IconButton>
          <input
            ref={fileInputRef}
            className="deck-rd-file-input"
            type="file"
            multiple
            onChange={(event) => {
              uploadFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />

          <IconButton
            label={t("deckRdRefreshFrame")}
            onClick={() => sendControl({ t: "idr" })}
          >
            <Icon name="refresh" size={14} />
          </IconButton>
          <Menu
            label={t("deckRdStats")}
            items={settingItems}
            trigger={
              <IconButton label={t("dshDeckT3Settings")}>
                <Icon name="sliders" size={14} />
              </IconButton>
            }
          />
          <IconButton
            label={fullscreen ? t("deckRdExitFullscreen") : t("deckRdFullscreen")}
            onClick={() => void toggleFullscreen()}
          >
            <Icon name="maximize" size={14} />
          </IconButton>
        </div>
      </div>

      {!permissions.screenRecording ? (
        <Banner
          tone="danger"
          action={
            <Button size="sm" variant="ghost" onClick={() => sendControl({ t: "perm" })}>
              {t("deckRdPermRecheck")}
            </Button>
          }
        >
          {t("deckRdPermScreenMissing")}
        </Banner>
      ) : !permissions.accessibility ? (
        <Banner
          tone="warn"
          action={
            <Button size="sm" variant="ghost" onClick={() => sendControl({ t: "perm" })}>
              {t("deckRdPermRecheck")}
            </Button>
          }
        >
          {t("deckRdPermAxMissing")}
        </Banner>
      ) : null}

      <div
        ref={stageRef}
        className={["deck-rd-stage", focused ? "is-focused" : ""].filter(Boolean).join(" ")}
        role="application"
        aria-label={`${deviceName} remote desktop`}
        onDragOver={onDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className={["deck-rd-viewport", scaleMode === "actual" ? "is-actual" : ""].filter(Boolean).join(" ")}>
          <div
            ref={surfaceRef}
            className={["deck-rd-surface", cursorInVideo ? "is-cursor-hidden" : ""].filter(Boolean).join(" ")}
            style={surfaceStyle}
          >
            <video
              ref={videoRef}
              className="deck-rd-video"
              autoPlay
              playsInline
              muted
              disablePictureInPicture
              onLoadedData={(event) => {
                const el = event.currentTarget;
                if (el.videoWidth > 0 && el.videoHeight > 0) {
                  setVideoSize({ w: el.videoWidth, h: el.videoHeight });
                  onVideoMediaReadyRef.current?.();
                }
              }}
              onPlaying={(event) => {
                const el = event.currentTarget;
                if (el.videoWidth > 0 && el.videoHeight > 0) {
                  setVideoSize({ w: el.videoWidth, h: el.videoHeight });
                  onVideoMediaReadyRef.current?.();
                }
              }}
              onResize={(event) => {
                const el = event.currentTarget;
                if (el.videoWidth > 0 && el.videoHeight > 0) {
                  setVideoSize({ w: el.videoWidth, h: el.videoHeight });
                }
              }}
            />
          </div>
        </div>

        <textarea
          ref={imeRef}
          className="deck-rd-ime"
          style={{ left: imeAnchor.x, top: imeAnchor.y - 20 }}
          aria-label={`${deviceName} keyboard input`}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          tabIndex={-1}
          onFocus={() => {
            setFocused(true);
            void syncLocalClipboardOnFocus();
          }}
          onBlur={() => {
            setFocused(false);
            releaseAllKeys();
            composingRef.current = false;
            setComposition(null);
            if (imeRef.current) imeRef.current.value = "";
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onPaste={handlePaste}
          onCopy={(event) => event.preventDefault()}
          onCut={(event) => event.preventDefault()}
          onCompositionStart={() => {
            composingRef.current = true;
            setComposition("");
          }}
          onCompositionUpdate={(event) => setComposition(event.data ?? "")}
          onCompositionEnd={() => {
            composingRef.current = false;
            setComposition(null);
            // 部分浏览器在 compositionend 之后才写入最终文字，延后一拍再读。
            setTimeout(flushImeText, 0);
          }}
          onInput={(event) => {
            const native = event.nativeEvent as InputEvent;
            if (composingRef.current || native.isComposing) return;
            flushImeText();
          }}
        />
        {composition ? (
          <div className="deck-rd-ime-preview" style={{ left: imeAnchor.x, top: imeAnchor.y }} aria-label={t("deckRdImeComposing")}>
            <u>{composition}</u>
          </div>
        ) : null}

        {showStats && status.kind === "ready" ? (
          <dl className="deck-rd-stats">
            <dt>{t("deckRdStatsRtt")}</dt>
            <dd>{rttMs !== null ? `${rttMs} ms` : "—"}</dd>
            <dt>{t("deckRdStatsFps")}</dt>
            <dd>{stats?.fps ?? "—"}</dd>
            <dt>{t("deckRdStatsBitrate")}</dt>
            <dd>{stats?.bitrateBps ? formatBitrate(stats.bitrateBps) : "—"}</dd>
            <dt>{t("deckRdStatsHostBitrate")}</dt>
            <dd>{hostStats ? formatBitrate(hostStats.bitrateBps) : "—"}</dd>
            <dt>{t("deckRdStatsLoss")}</dt>
            <dd>{lossPct !== null ? `${lossPct}%` : "—"}</dd>
            <dt>{t("deckRdStatsJitter")}</dt>
            <dd>{stats?.jitterBufferMs !== null && stats?.jitterBufferMs !== undefined ? `${stats.jitterBufferMs} ms` : "—"}</dd>
            <dt>{t("deckRdStatsDecode")}</dt>
            <dd>{stats?.decodeMs !== null && stats?.decodeMs !== undefined ? `${stats.decodeMs} ms` : "—"}</dd>
            <dt>{t("deckRdStatsResolution")}</dt>
            <dd>{videoSize ? `${videoSize.w}×${videoSize.h}` : "—"}</dd>
            <dt>{t("deckRdStatsPath")}</dt>
            <dd>
              {stats?.relay === null || stats?.relay === undefined
                ? "—"
                : stats.relay
                  ? t("deckRdStatsPathRelay")
                  : t("deckRdStatsPathDirect")}
            </dd>
          </dl>
        ) : null}

        {showTransfers ? (
          <div className="deck-rd-transfers">
            {transfers.length > 0 ? (
              <>
                <div className="deck-rd-transfers-head">
                  <span>{t("deckRdTransfers")}</span>
                  <button type="button" className="deck-rd-link-btn" onClick={() => fileClientRef.current?.clearFinished()}>
                    {t("deckRdTransferClear")}
                  </button>
                </div>
                {transfers.map((item) => {
                  const pct = item.size > 0 ? Math.min(100, Math.round((item.transferred / item.size) * 100)) : item.status === "done" ? 100 : 0;
                  const meta =
                    item.status === "queued"
                      ? t("deckRdTransferQueued")
                      : item.status === "active"
                        ? `${formatBytes(item.transferred)} / ${formatBytes(item.size)}`
                        : item.status === "done"
                          ? item.savedAt
                            ? item.direction === "up"
                              ? t("deckRdTransferSavedRemote", { path: item.savedAt })
                              : t("deckRdTransferSavedLocal", { path: item.savedAt })
                            : t("deckRdTransferDone")
                          : item.status === "cancelled"
                            ? t("deckRdTransferCancelled")
                            : (item.error ?? "");
                  return (
                    <div
                      key={item.id}
                      className={["deck-rd-transfer", item.status === "error" ? "is-error" : "", item.status === "done" ? "is-done" : ""].filter(Boolean).join(" ")}
                    >
                      <div className="deck-rd-transfer-row">
                        <Icon name={item.direction === "up" ? "arrow-up" : "arrow-down"} size={12} />
                        <span className="deck-rd-transfer-name" title={item.name}>{item.name}</span>
                        {item.status === "active" || item.status === "queued" ? (
                          <button type="button" className="deck-rd-link-btn" onClick={() => fileClientRef.current?.cancel(item.id)}>
                            {t("deckRdTransferCancel")}
                          </button>
                        ) : null}
                      </div>
                      <div className="deck-rd-transfer-bar"><span style={{ width: `${pct}%` }} /></div>
                      <span className="deck-rd-transfer-meta" title={meta}>{meta}</span>
                    </div>
                  );
                })}
              </>
            ) : null}
            {remoteFiles.length > 0 ? (
              <div className="deck-rd-remote-files">
                <div className="deck-rd-transfers-head">
                  <span>{t("deckRdRemoteFiles", { count: remoteFiles.length })}</span>
                  <button type="button" className="deck-rd-link-btn" aria-label="close" onClick={() => setRemoteFiles([])}>
                    <Icon name="x" size={12} />
                  </button>
                </div>
                {remoteFiles.map((file) => (
                  <div key={file.path} className="deck-rd-transfer-row">
                    <Icon name="file" size={12} />
                    <span className="deck-rd-transfer-name" title={file.path}>{file.name}</span>
                    <span className="deck-rd-transfer-meta">{formatBytes(file.size)}</span>
                    <button type="button" className="deck-rd-link-btn" onClick={() => fileClientRef.current?.download(file)}>
                      {t("deckRdDownload")}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {dragOver ? <div className="deck-rd-drop">{t("deckRdDropHint")}</div> : null}

        {isConnecting ? (
          <div className="deck-rd-overlay" role="status">
            <Spinner />
            <p>
              {status.kind === "reconnecting"
                ? t("deckRdReconnecting", { attempt: status.attempt })
                : status.stage === "turn"
                  ? t("deckRdStageTurn")
                  : status.stage === "signaling"
                    ? t("deckRdStageSignaling")
                    : t("deckRdStageIce")}
            </p>
          </div>
        ) : status.kind === "closed" ? (
          <div className="deck-rd-overlay" role="status">
            <p className="dsh-deck-error">{t("deckRdClosed")}</p>
            <Button size="sm" onClick={() => setReconnectNonce((n) => n + 1)}>
              {t("deckRdReconnect")}
            </Button>
          </div>
        ) : status.kind === "error" ? (
          <div className="deck-rd-overlay" role="status">
            <p className="dsh-deck-error">{t("deckRdFailed", { reason: status.reason })}</p>
            <Button size="sm" onClick={() => setReconnectNonce((n) => n + 1)}>
              {t("deckRdReconnect")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
