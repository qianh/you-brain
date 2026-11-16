import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { DeckTerminalSize } from "@you-brain/core/http/types.js";
import "@xterm/xterm/css/xterm.css";

import { useDaemon } from "../daemon-context.js";
import { preserveTerminalImeInput } from "./deck-terminal-input.js";
import { createLatencyProbe } from "./deck-terminal-latency.js";
import type { TerminalAppearance } from "./deck-terminal-font.js";

type Status = "connecting" | "ready" | "disconnected" | "exited";

/** 仅开发模式：地址带 ?webgl=off 时不加载 GPU 渲染，用来和开启时对比延迟。正式包里恒为 false。 */
function webglDisabledForDebug(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get("webgl") === "off";
}

/** 当前已创建的终端上要重新排版时用：字体变化、GPU 渲染回退都会改变单元格尺寸。 */
interface LiveTerminal {
  terminal: Terminal;
  relayout(): void;
}

/**
 * 同一真实 pane 的终端客户端；xterm 负责终端协议、输入法和按键编码，组件不编辑指令。
 * `appearance` 只改 xterm 的选项并重新排版，不重建终端和连接。
 */
export function DeckTty7Terminal({ pane, appearance }: { pane: number; appearance: TerminalAppearance }) {
  const { client, t } = useDaemon();
  const hostRef = useRef<HTMLDivElement>(null);
  // 建终端时读最新的外观；它不进建连 effect 的依赖，后续变化由下面单独的 effect 处理。
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const liveRef = useRef<LiveTerminal | null>(null);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<Status>("connecting");
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  /** tty7 把终端尺寸收回去了；后来 U-Brain 又拿到尺寸时清除。 */
  const [leaseLost, setLeaseLost] = useState(false);
  const [pasting, setPasting] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let connected = false;
    let failed = false;
    let exited = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let resizeFrame = 0;
    let layoutFrame = 0;
    let renderQueue = Promise.resolve();
    setStatus("connecting");
    setError(null);
    setWarning(null);
    setLeaseLost(false);
    setPasting(false);
    // 背景色只有一个来源：和屏幕、状态条同用 --term-bg，内边距处才不会出现色差。
    const background = getComputedStyle(host).getPropertyValue("--term-bg").trim();
    const { fontFamily, fontSize, lineHeight } = appearanceRef.current;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      cursorInactiveStyle: "outline",
      fontFamily,
      fontSize,
      lineHeight,
      scrollback: 10_000,
      minimumContrastRatio: 1,
      macOptionIsMeta: true,
      disableStdin: true,
      theme: { ...(background === "" ? {} : { background }), foreground: "#e4e4e7", cursor: "#f4f4f5", selectionBackground: "#53617f99" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    host.addEventListener("keydown", preserveTerminalImeInput, true);
    // GPU 渲染：构造或加载失败就继续用默认渲染；上下文丢失时释放扩展，退回默认渲染。
    let webgl: WebglAddon | undefined;
    if (!webglDisabledForDebug()) {
      try {
        webgl = new WebglAddon();
        const addon = webgl;
        addon.onContextLoss(() => {
          addon.dispose();
          if (webgl === addon) webgl = undefined;
          if (!disposed) scheduleRelayout();
        });
        terminal.loadAddon(addon);
      } catch {
        try { webgl?.dispose(); } catch { /* 半途失败的扩展释放不了也不影响默认渲染。 */ }
        webgl = undefined;
      }
    }
    fit.fit();
    const measure = (): DeckTerminalSize => {
      const grid = fit.proposeDimensions();
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      return {
        cols: Math.max(2, Math.min(1000, grid?.cols ?? terminal.cols)),
        rows: Math.max(1, Math.min(1000, grid?.rows ?? terminal.rows)),
        cell_w: Math.round((screen?.clientWidth ?? 0) / terminal.cols),
        cell_h: Math.round((screen?.clientHeight ?? 0) / terminal.rows),
      };
    };
    const socket = client.deckTty7Terminal(pane, measure());
    const control = (body: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
    };
    // 字体或渲染方式变化后单元格尺寸会变：重新适配并把新尺寸告诉 tty7（只发 resize，不重连）。
    const relayout = (): void => {
      if (disposed) return;
      fit.fit();
      if (connected) control({ type: "resize", size: measure() });
    };
    const scheduleRelayout = (): void => {
      cancelAnimationFrame(layoutFrame);
      layoutFrame = requestAnimationFrame(relayout);
    };
    liveRef.current = { terminal, relayout: scheduleRelayout };
    // 仅开发模式：输入到写入完成的延迟，正式包里这段会被整体删掉。
    const probe = import.meta.env.DEV
      ? createLatencyProbe({
        batch: 50,
        now: () => performance.now(),
        report: (stats) => console.info(
          `[终端延迟] webgl=${webgl === undefined ? "off" : "on"} 最近 ${stats.count} 次 中位数 ${stats.median.toFixed(1)}ms 95分位 ${stats.p95.toFixed(1)}ms`),
      })
      : null;
    const send = (bytes: Uint8Array): void => {
      if (!connected || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount + bytes.length > 1024 * 1024) {
        failed = true;
        setError("终端输入积压，连接已断开；未自动重发");
        socket.close();
        return;
      }
      socket.send(bytes);
    };
    const data = terminal.onData((text) => {
      probe?.input();
      send(new TextEncoder().encode(text));
    });
    // 非 UTF-8 的鼠标报告等必须逐字节发送，不经过 TextEncoder。
    const binary = terminal.onBinary((text) => send(Uint8Array.from(text, (char) => char.charCodeAt(0))));
    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (disposed) return;
      // resize 必须排在前一段 write 完成之后；tty7 的回放包含不同尺寸的历史段。
      renderQueue = renderQueue.then(async () => {
        if (disposed) return;
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data);
          await new Promise<void>((resolve) => terminal.write(bytes, () => {
            probe?.written();
            resolve();
          }));
          if (!disposed) control({ type: "ack", bytes: bytes.length });
          return;
        }
        const message = JSON.parse(event.data);
        if (message.type === "ready") {
          connected = true;
          terminal.options.disableStdin = false;
          setStatus("ready");
          control({ type: "resize", size: measure() });
          terminal.focus();
        } else if (message.type === "size") terminal.resize(message.size.cols, message.size.rows);
        else if (message.type === "warning") setWarning(message.message);
        else if (message.type === "lease") setLeaseLost(message.by !== "U-Brain");
        else if (message.type === "exit") {
          exited = true;
          connected = false;
          terminal.options.disableStdin = true;
          setStatus("exited");
        } else if (message.type === "error") {
          failed = true;
          setError(message.message);
        }
      }).catch(() => {
        if (disposed) return;
        failed = true;
        setError("无法解析终端数据，请重新连接");
        socket.close();
      });
    };
    socket.onclose = () => {
      connected = false;
      if (disposed) return;
      terminal.options.disableStdin = true;
      // 等排队的 exit/error 事件处理完，避免误把会话结束当成网络断线。
      void renderQueue.finally(() => {
        if (disposed || exited) return;
        setStatus("disconnected");
        if (!failed) retry = setTimeout(() => setRevision((value) => value + 1), 1500);
      });
    };
    socket.onerror = () => { /* close 负责重连和显示连接状态。 */ };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (connected) control({ type: "resize", size: measure() });
      });
    });
    observer.observe(host);
    const onFocus = (): void => setFocused(true);
    const onBlur = (): void => setFocused(false);
    host.addEventListener("focusin", onFocus);
    host.addEventListener("focusout", onBlur);
    const onPaste = (event: ClipboardEvent): void => {
      const images = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
      if (images.length === 0) return; // 文本由 xterm 根据真实 bracketed-paste 模式处理。
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!connected) return;
      setPasting(true);
      void (async () => {
        try {
          const paths: string[] = [];
          for (const image of images) paths.push((await client.deckTty7PasteImage(image)).path);
          if (!disposed && connected) {
            terminal.paste(paths.join(" "));
            terminal.focus();
          }
        } catch (caught) {
          if (!disposed) setError(caught instanceof Error ? caught.message : String(caught));
        } finally { if (!disposed) setPasting(false); }
      })();
    };
    host.addEventListener("paste", onPaste, true);
    const focusFrame = requestAnimationFrame(() => terminal.focus());
    return () => {
      disposed = true;
      connected = false;
      clearTimeout(retry);
      cancelAnimationFrame(focusFrame);
      cancelAnimationFrame(resizeFrame);
      cancelAnimationFrame(layoutFrame);
      if (liveRef.current?.terminal === terminal) liveRef.current = null;
      observer.disconnect();
      host.removeEventListener("focusin", onFocus);
      host.removeEventListener("focusout", onBlur);
      host.removeEventListener("keydown", preserveTerminalImeInput, true);
      host.removeEventListener("paste", onPaste, true);
      socket.close();
      data.dispose();
      binary.dispose();
      terminal.dispose();
    };
  }, [client, pane, revision]);

  // 外观变化：只改 xterm 选项并重新排版，不重建终端和连接。
  const { fontFamily, fontSize, lineHeight } = appearance;
  useEffect(() => {
    const live = liveRef.current;
    if (live === null) return;
    const { options } = live.terminal;
    if (options.fontFamily === fontFamily && options.fontSize === fontSize && options.lineHeight === lineHeight) return;
    options.fontFamily = fontFamily;
    options.fontSize = fontSize;
    options.lineHeight = lineHeight;
    live.relayout();
  }, [fontFamily, fontSize, lineHeight]);

  const connectionText = status === "ready" ? null
    : t(status === "connecting" ? "deckTty7Connecting" : status === "exited" ? "deckTty7Exited" : "deckTty7Disconnected");
  const hasFloat = connectionText !== null || pasting || error !== null || warning !== null || leaseLost;
  return (
    <div className={`deck-tty7-terminal${focused ? " is-focused" : ""}`}>
      <div ref={hostRef} className="deck-tty7-xterm" aria-label={t("deckTty7ScreenLabel")}
        // xterm 已编码这些按键；不要让应用快捷键再处理。
        onKeyDown={(event) => event.stopPropagation()} />
      {/* 状态悬浮在终端右下角，只在有内容时出现，不占终端的行列。 */}
      {hasFloat && <div className="deck-tty7-float">
        {connectionText !== null && <p className="deck-tty7-float-item" role="status">
          {connectionText}
          {status === "disconnected" && <button type="button" className="btn small quiet"
            onClick={() => setRevision((value) => value + 1)}>{t("deckTty7Reconnect")}</button>}
        </p>}
        {pasting && <p className="deck-tty7-float-item" role="status">{t("deckTty7Pasting")}</p>}
        {error !== null && <p className="deck-tty7-float-item is-error" role="alert">{error}</p>}
        {warning !== null && <p className="deck-tty7-float-item" role="status">{warning}</p>}
        {leaseLost && <p className="deck-tty7-float-item" role="status">{t("deckTty7LeaseLost")}</p>}
      </div>}
    </div>
  );
}
