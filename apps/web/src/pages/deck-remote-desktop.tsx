import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import type {
  ControlClientMessage,
  ControlServerMessage,
  FastInputMessage,
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
import { Spinner } from "../components/spinner.js";
import { useOptionalToast } from "../components/toast.js";
import { useDaemon } from "../daemon-context.js";
import {
  applyZeroPlayoutDelay,
  computeVideoContentBox,
  extractModifiers,
  mapDomMouseButton,
  normalizeVideoPoint,
  normalizeWheelDelta,
} from "../lib/remote-desktop-input.js";

const FALLBACK_ICE_SERVERS: IceServerEntry[] = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];

type SessionStatus =
  | { kind: "connecting" }
  | { kind: "ready" }
  | { kind: "closed" }
  | { kind: "error"; reason: string };

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

  const [status, setStatus] = useState<SessionStatus>({ kind: "connecting" });
  const [quality, setQuality] = useState<RdQuality>("hd");
  const [displays, setDisplays] = useState<RdDisplayInfo[]>([]);
  const [activeDisplayId, setActiveDisplayId] = useState<number>(0);
  const [permissions, setPermissions] = useState<RdPermissions>({
    screenRecording: true,
    accessibility: true,
  });
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [resolution, setResolution] = useState<{ w: number; h: number } | null>(null);
  const [focused, setFocused] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [reconnectNonce, setReconnectNonce] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fastDcRef = useRef<RTCDataChannel | null>(null);
  const controlDcRef = useRef<RTCDataChannel | null>(null);
  const pressedButtonRef = useRef<0 | 1 | 2 | undefined>(undefined);
  const pressedKeysRef = useRef(new Set<string>());
  const pendingMoveRef = useRef<FastInputMessage | null>(null);
  const moveRafRef = useRef<number | null>(null);
  const composingRef = useRef(false);
  const qualityRef = useRef<RdQuality>(quality);
  qualityRef.current = quality;

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

  const releaseAllKeys = useCallback(() => {
    const keys = [...pressedKeysRef.current];
    pressedKeysRef.current.clear();
    for (const code of keys) {
      sendControl({ t: "ku", code });
    }
    if (pressedButtonRef.current !== undefined) {
      const btn = pressedButtonRef.current;
      pressedButtonRef.current = undefined;
      sendControl({ t: "mu", x: 0.5, y: 0.5, b: btn });
    }
  }, [sendControl]);

  // 全屏状态同步
  useEffect(() => {
    const onFullscreenChange = () => {
      setFullscreen(document.fullscreenElement === rootRef.current);
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
    let sessionId: string | null = null;
    let remoteDescriptionReady = false;
    const remoteIceBuffer: RdIceCandidate[] = [];
    const localIceBuffer: RdIceCandidate[] = [];
    let localIceTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    const sseAbort = new AbortController();

    setStatus({ kind: "connecting" });
    setRttMs(null);
    setResolution(null);

    let pc: RTCPeerConnection | null = null;

    const flushLocalIce = () => {
      if (localIceTimer !== null) {
        clearTimeout(localIceTimer);
        localIceTimer = null;
      }
      if (disposed || !sessionId || localIceBuffer.length === 0) return;
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
      if (!sessionId) return;
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

    // 先订阅 SSE，确保不漏掉 answer 返回前后的任何增量 ICE / 状态帧
    if (typeof client.dispatchRdEvents === "function") {
      void client
        .dispatchRdEvents(
          (event) => {
            if (disposed || event.from !== deviceId) return;
            if (event.kind === "rd.ice") {
              if (sessionId && event.data.sessionId !== sessionId) return;
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
              if (sessionId && event.data.sessionId !== sessionId) return;
              if (event.data.displays) setDisplays(event.data.displays);
              if (event.data.activeDisplayId !== undefined) {
                setActiveDisplayId(event.data.activeDisplayId);
              }
              if (event.data.permissions) setPermissions(event.data.permissions);
              if (event.data.state === "ready") {
                setStatus({ kind: "ready" });
              } else if (event.data.state === "closed") {
                setStatus({ kind: "closed" });
              } else if (event.data.state === "error") {
                setStatus({
                  kind: "error",
                  reason: event.data.error || t("dshDeckT3CheckError"),
                });
              }
            }
          },
          { signal: sseAbort.signal },
        )
        .catch(() => undefined);
    }

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
      fastDcRef.current = fastDc;
      controlDcRef.current = controlDc;

      controlDc.addEventListener("open", () => {
        if (disposed) return;
        sendControl({ t: "ping", ts: Math.round(performance.now()) });
        pingTimer = setInterval(() => {
          sendControl({ t: "ping", ts: Math.round(performance.now()) });
        }, 2_000);
      });

      controlDc.addEventListener("message", (ev) => {
        if (disposed || typeof ev.data !== "string") return;
        let msg: ControlServerMessage;
        try {
          msg = JSON.parse(ev.data) as ControlServerMessage;
        } catch {
          return;
        }
        if (msg.t === "state") {
          setDisplays(msg.displays);
          setActiveDisplayId(msg.activeDisplayId);
          setPermissions(msg.permissions);
        } else if (msg.t === "pong") {
          const delta = Math.max(0, Math.round(performance.now()) - msg.ts);
          if (delta < 30_000) setRttMs(delta);
        } else if (msg.t === "cb") {
          void navigator.clipboard?.writeText(msg.text).then(
            () => push({ message: t("deckRdClipboardPulled") }),
            () => push({ message: t("deckRdClipboardFailed"), tone: "danger" }),
          );
        }
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
        setStatus({ kind: "ready" });
      });

      pc.addEventListener("icecandidate", (ev) => {
        if (disposed || !ev.candidate) return;
        enqueueLocalIce({
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
          usernameFragment: ev.candidate.usernameFragment,
        });
      });

      pc.addEventListener("connectionstatechange", () => {
        if (disposed || !pc) return;
        if (pc.connectionState === "connected") {
          setStatus({ kind: "ready" });
          for (const receiver of pc.getReceivers()) applyZeroPlayoutDelay(receiver);
        } else if (pc.connectionState === "failed") {
          setStatus({ kind: "error", reason: "ICE / P2P 连接协商失败" });
        } else if (pc.connectionState === "closed") {
          setStatus({ kind: "closed" });
        }
      });

      const offer = await pc.createOffer();
      if (disposed) return;
      await pc.setLocalDescription(offer);
      if (disposed) return;

      const outcome = await client.dispatchSend!({
        to: deviceId,
        kind: "rd.open",
        args: {
          offerSdp: pc.localDescription?.sdp ?? offer.sdp ?? "",
          quality: qualityRef.current,
        },
      });
      if (disposed) return;
      if (!outcome.ok) {
        setStatus({ kind: "error", reason: outcome.error });
        return;
      }
      if (!isRdOpenResult(outcome.result)) {
        setStatus({ kind: "error", reason: "远端返回了无效的桌面会话应答" });
        return;
      }

      sessionId = outcome.result.sessionId;
      setDisplays(outcome.result.displays);
      setActiveDisplayId(outcome.result.activeDisplayId);
      setPermissions(outcome.result.permissions);

      await pc.setRemoteDescription({
        type: "answer",
        sdp: outcome.result.answerSdp,
      });
      if (disposed) return;
      remoteDescriptionReady = true;

      while (remoteIceBuffer.length > 0) {
        const next = remoteIceBuffer.shift();
        if (next) applyRemoteCandidate(next);
      }
      flushLocalIce();
    };

    void start().catch((error: unknown) => {
      if (disposed) return;
      setStatus({
        kind: "error",
        reason: error instanceof Error ? error.message : String(error),
      });
    });

    return () => {
      disposed = true;
      sseAbort.abort();
      if (localIceTimer !== null) clearTimeout(localIceTimer);
      if (pingTimer !== null) clearInterval(pingTimer);
      if (moveRafRef.current !== null) {
        cancelAnimationFrame(moveRafRef.current);
        moveRafRef.current = null;
      }
      fastDcRef.current = null;
      controlDcRef.current = null;
      const video = videoRef.current;
      if (video) video.srcObject = null;
      if (pc) {
        try {
          pc.close();
        } catch {
          // ignore
        }
      }
      if (sessionId && typeof client.dispatchSend === "function") {
        void client
          .dispatchSend({
            to: deviceId,
            kind: "rd.close",
            args: { sessionId },
          })
          .catch(() => undefined);
      }
    };
  }, [active, client, deviceId, push, reconnectNonce, reloadCount, sendControl, t]);

  const pointFromPointerEvent = useCallback(
    (event: { clientX: number; clientY: number }): { x: number; y: number } => {
      const stage = stageRef.current;
      const video = videoRef.current;
      if (!stage) return { x: 0.5, y: 0.5 };
      const rect = stage.getBoundingClientRect();
      const box = computeVideoContentBox(
        rect.width,
        rect.height,
        video?.videoWidth ?? 0,
        video?.videoHeight ?? 0,
      );
      return normalizeVideoPoint(event.clientX - rect.left, event.clientY - rect.top, box);
    },
    [],
  );

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (status.kind !== "ready") return;
    const pt = pointFromPointerEvent(event);
    pendingMoveRef.current = { t: "mm", x: pt.x, y: pt.y };
    if (moveRafRef.current === null) {
      moveRafRef.current = requestAnimationFrame(() => {
        moveRafRef.current = null;
        const latest = pendingMoveRef.current;
        pendingMoveRef.current = null;
        if (latest) sendFast(latest);
      });
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    stageRef.current?.focus({ preventScroll: true });
    if (status.kind !== "ready") return;
    const btn = mapDomMouseButton(event.button);
    if (btn === null) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    const pt = pointFromPointerEvent(event);
    pressedButtonRef.current = btn;
    const clicks = Math.max(1, Math.min(3, event.detail || 1));
    sendControl({ t: "md", x: pt.x, y: pt.y, b: btn, clicks });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (status.kind !== "ready") return;
    const btn = mapDomMouseButton(event.button) ?? pressedButtonRef.current;
    if (btn === null || btn === undefined) return;
    event.preventDefault();
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // ignore
    }
    const pt = pointFromPointerEvent(event);
    if (pressedButtonRef.current === btn) pressedButtonRef.current = undefined;
    sendControl({ t: "mu", x: pt.x, y: pt.y, b: btn });
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (status.kind !== "ready") return;
    const { dx, dy } = normalizeWheelDelta(event.deltaX, event.deltaY, event.deltaMode);
    if (dx === 0 && dy === 0) return;
    const pt = pointFromPointerEvent(event);
    sendFast({ t: "wh", x: pt.x, y: pt.y, dx, dy });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!focused || status.kind !== "ready" || composingRef.current) return;
    if (event.nativeEvent.isComposing || event.key === "Process") return;
    event.preventDefault();
    event.stopPropagation();
    const code = event.code;
    if (!code) return;
    pressedKeysRef.current.add(code);
    sendControl({ t: "kd", code, ...extractModifiers(event) });
  };

  const handleKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!focused || status.kind !== "ready") return;
    const code = event.code;
    if (!code) return;
    event.preventDefault();
    event.stopPropagation();
    pressedKeysRef.current.delete(code);
    sendControl({ t: "ku", code, ...extractModifiers(event) });
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
      if (sendControl({ t: "cb.set", text })) {
        push({ message: t("deckRdClipboardSent") });
      }
    } catch {
      push({ message: t("deckRdClipboardFailed"), tone: "danger" });
    }
  };

  const toggleFullscreen = async () => {
    const el = rootRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement === el) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
      }
    } catch {
      // ignore fullscreen rejection
    }
  };

  return (
    <div ref={rootRef} className="deck-rd-root" hidden={!active}>
      <div className="deck-rd-toolbar">
        <div className="deck-rd-toolbar-left">
          {canBackToT3 && onBackToT3 ? (
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
            <span className="deck-rd-telemetry" aria-live="polite">
              <span className="deck-rd-dot is-live" />
              {rttMs !== null ? <span>{rttMs} ms</span> : <span>60fps</span>}
              {resolution ? <span>{resolution.w}×{resolution.h}</span> : null}
            </span>
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

          <Button size="sm" variant="ghost" onClick={pullClipboard}>
            {t("deckRdSyncFromRemote")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void pushClipboard()}>
            {t("deckRdSyncToRemote")}
          </Button>

          <IconButton
            label={t("deckRdRefreshFrame")}
            onClick={() => sendControl({ t: "idr" })}
          >
            <Icon name="refresh" size={14} />
          </IconButton>
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
        tabIndex={0}
        role="application"
        aria-label={`${deviceName} remote desktop`}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          releaseAllKeys();
        }}
        onContextMenu={(event) => event.preventDefault()}
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          if (event.data) {
            sendControl({ t: "txt", text: event.data });
          }
        }}
      >
        <video
          ref={videoRef}
          className="deck-rd-video"
          autoPlay
          playsInline
          muted
          disablePictureInPicture
          onLoadedMetadata={(event) => {
            const el = event.currentTarget;
            if (el.videoWidth > 0 && el.videoHeight > 0) {
              setResolution({ w: el.videoWidth, h: el.videoHeight });
            }
          }}
          onResize={(event) => {
            const el = event.currentTarget;
            if (el.videoWidth > 0 && el.videoHeight > 0) {
              setResolution({ w: el.videoWidth, h: el.videoHeight });
            }
          }}
        />

        {status.kind === "connecting" ? (
          <div className="deck-rd-overlay" role="status">
            <Spinner />
            <p>{t("deckRdConnecting")}</p>
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
