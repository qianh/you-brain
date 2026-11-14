import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { DeckTerminalSize } from "@you-brain/core/http/types.js";
import "@xterm/xterm/css/xterm.css";

import { useDaemon } from "../daemon-context.js";

type Status = "connecting" | "ready" | "disconnected" | "exited";

/** 同一真实 pane 的终端客户端；xterm 负责终端协议、输入法和按键编码，组件不编辑指令。 */
export function DeckTty7Terminal({ pane }: { pane: number }) {
  const { client, t } = useDaemon();
  const hostRef = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<Status>("connecting");
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
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
    let renderQueue = Promise.resolve();
    setStatus("connecting");
    setError(null);
    setWarning(null);
    setPasting(false);
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      cursorInactiveStyle: "outline",
      fontFamily: '"SFMono-Regular", Menlo, Monaco, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 10_000,
      minimumContrastRatio: 1,
      macOptionIsMeta: true,
      disableStdin: true,
      theme: { background: "#15171b", foreground: "#e4e4e7", cursor: "#f4f4f5", selectionBackground: "#53617f99" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
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
    const data = terminal.onData((text) => send(new TextEncoder().encode(text)));
    // 非 UTF-8 的鼠标报告等必须逐字节发送，不经过 TextEncoder。
    const binary = terminal.onBinary((text) => send(Uint8Array.from(text, (char) => char.charCodeAt(0))));
    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (disposed) return;
      // resize 必须排在前一段 write 完成之后；tty7 的回放包含不同尺寸的历史段。
      renderQueue = renderQueue.then(async () => {
        if (disposed) return;
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data);
          await new Promise<void>((resolve) => terminal.write(bytes, resolve));
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
        else if (message.type === "lease" && message.by !== "U-Brain") {
          setWarning("终端尺寸已交回 tty7；关闭后重新打开可使用当前窗口尺寸。");
        } else if (message.type === "exit") {
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
      observer.disconnect();
      host.removeEventListener("focusin", onFocus);
      host.removeEventListener("focusout", onBlur);
      host.removeEventListener("paste", onPaste, true);
      socket.close();
      data.dispose();
      binary.dispose();
      terminal.dispose();
    };
  }, [client, pane, revision]);

  return (
    <>
      <div className={`deck-tty7-terminal${focused ? " is-focused" : ""}`}>
        <div ref={hostRef} className="deck-tty7-xterm" aria-label={t("deckTty7ScreenLabel")}
          // xterm 已编码这些按键；不要让 Dialog 的焦点循环和应用快捷键再处理。
          onKeyDown={(event) => event.stopPropagation()} />
      </div>
      {status !== "ready" && <p className="deck-tty7-connection-status" role="status">
        {t(status === "connecting" ? "deckTty7Connecting" : status === "exited" ? "deckTty7Exited" : "deckTty7Disconnected")}
        {status === "disconnected" && <button type="button" className="btn small quiet"
          onClick={() => setRevision((value) => value + 1)}>{t("deckTty7Reconnect")}</button>}
      </p>}
      {pasting && <p className="deck-tty7-hint" role="status">{t("deckTty7Pasting")}</p>}
      {error !== null && <p className="deck-tty7-error" role="alert">{error}</p>}
      {warning !== null && <p className="deck-tty7-hint" role="status">{warning}</p>}
      <p className="deck-tty7-hint">{t("deckTty7DirectHint")}</p>
    </>
  );
}
