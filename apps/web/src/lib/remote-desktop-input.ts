export interface KeyModifierFlags {
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface VideoContentBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 计算 `object-fit: contain` 下 `<video>` 真实画面在容器内的矩形。
 * 确保存在黑边（letterbox / pillarbox）时，鼠标归一化坐标仍 1:1 对应远端桌面像素。
 */
export function computeVideoContentBox(
  containerWidth: number,
  containerHeight: number,
  videoWidth: number,
  videoHeight: number,
): VideoContentBox {
  if (containerWidth <= 0 || containerHeight <= 0) {
    return { left: 0, top: 0, width: 1, height: 1 };
  }
  if (videoWidth <= 0 || videoHeight <= 0) {
    return { left: 0, top: 0, width: containerWidth, height: containerHeight };
  }
  const containerRatio = containerWidth / containerHeight;
  const videoRatio = videoWidth / videoHeight;
  if (videoRatio > containerRatio) {
    const width = containerWidth;
    const height = containerWidth / videoRatio;
    return {
      left: 0,
      top: (containerHeight - height) / 2,
      width,
      height,
    };
  }
  const height = containerHeight;
  const width = containerHeight * videoRatio;
  return {
    left: (containerWidth - width) / 2,
    top: 0,
    width,
    height,
  };
}

/** 将容器内局部像素坐标映射为远端桌面归一化坐标 `[0, 1]`。 */
export function normalizeVideoPoint(
  localX: number,
  localY: number,
  box: VideoContentBox,
): { x: number; y: number } {
  const rawX = box.width > 0 ? (localX - box.left) / box.width : 0.5;
  const rawY = box.height > 0 ? (localY - box.top) / box.height : 0.5;
  return {
    x: Math.max(0, Math.min(1, Number.isFinite(rawX) ? rawX : 0.5)),
    y: Math.max(0, Math.min(1, Number.isFinite(rawY) ? rawY : 0.5)),
  };
}

/** DOM `MouseEvent.button` 映射为协议按钮编号（0=左键, 1=中键, 2=右键）。 */
export function mapDomMouseButton(button: number): 0 | 1 | 2 | null {
  if (button === 0 || button === 1 || button === 2) return button;
  return null;
}

/**
 * 将 DOM `WheelEvent` 转换为 macOS 像素级自然滚动增量。
 * DOM `deltaY > 0` 表示向下看（滚轮下拨），而 macOS `CGEvent` 正值表示向上滚，因此取反。
 */
export function normalizeWheelDelta(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
): { dx: number; dy: number } {
  const scale = deltaMode === 1 ? 24 : deltaMode === 2 ? 480 : 1;
  // 保留两位小数：触控板细粒度滚动交给远端累积，不在这里取整丢掉。
  const dx = Math.round(-deltaX * scale * 100) / 100;
  const dy = Math.round(-deltaY * scale * 100) / 100;
  return {
    dx: dx === 0 ? 0 : Math.max(-2400, Math.min(2400, dx)),
    dy: dy === 0 ? 0 : Math.max(-2400, Math.min(2400, dy)),
  };
}

/**
 * 提取键盘事件上的修饰键标记。始终给出明确的 true/false，
 * 远端据此清掉残留的修饰键状态，避免松开 ⌘ 后仍按 ⌘ 组合键处理。
 */
export function extractModifiers(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): Required<KeyModifierFlags> {
  return {
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
}

const CTRL_CMD_SWAP: Record<string, string> = {
  ControlLeft: "MetaLeft",
  ControlRight: "MetaRight",
  MetaLeft: "ControlLeft",
  MetaRight: "ControlRight",
};

/**
 * 非 Mac 控制端（Windows/Linux 键盘）操控 Mac 时互换 Ctrl 与 ⌘：
 * 习惯的 Ctrl+C / Ctrl+V 在远端就是 ⌘C / ⌘V。
 */
export function mapKeyForRemote(
  code: string,
  mods: Required<KeyModifierFlags>,
  swapCtrlCmd: boolean,
): { code: string; mods: Required<KeyModifierFlags> } {
  if (!swapCtrlCmd) return { code, mods };
  return {
    code: CTRL_CMD_SWAP[code] ?? code,
    mods: { ...mods, meta: mods.ctrl, ctrl: mods.meta },
  };
}

/** 本机输入法正在处理的按键（组字中或 keyCode 229），不应作为物理按键转发。 */
export function isImeKeyEvent(event: { isComposing?: boolean; keyCode?: number; key?: string }): boolean {
  return Boolean(event.isComposing) || event.keyCode === 229 || event.key === "Process";
}

/** 控制端是否为 Mac（决定 ⌘ 与 Ctrl 的默认映射）。 */
export function isMacPlatform(nav: { platform?: string; userAgent?: string } | undefined): boolean {
  if (!nav) return false;
  const platform = nav.platform ?? "";
  if (/mac|iphone|ipad|ipod/iu.test(platform)) return true;
  return /Mac OS X|Macintosh/u.test(nav.userAgent ?? "");
}

/**
 * 按远端双击间隔统计连击次数。pointerdown 的 `event.detail` 按规范恒为 0，
 * 只能自己判断：同一按键、间隔内、位移很小即累加，最多三击。
 */
export class ClickCounter {
  #last: { button: number; x: number; y: number; at: number; count: number } | null = null;

  register(button: number, x: number, y: number, atMs: number, intervalMs: number, slopPx = 5): number {
    const last = this.#last;
    let count = 1;
    if (
      last &&
      last.button === button &&
      atMs - last.at <= intervalMs &&
      Math.abs(x - last.x) <= slopPx &&
      Math.abs(y - last.y) <= slopPx
    ) {
      count = last.count >= 3 ? 1 : last.count + 1;
    }
    this.#last = { button, x, y, at: atMs, count };
    return count;
  }

  /** 当前（最近一次按下）的连击数，供抬起事件复用。 */
  get current(): number {
    return this.#last?.count ?? 1;
  }

  reset(): void {
    this.#last = null;
  }
}

/** 按固定长度切分文本，不拆开 UTF-16 代理对。 */
export function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

/** 重组远端按分片发送的剪贴板文本。 */
export class ClipboardAssembler {
  #id: string | null = null;
  #parts: string[] = [];
  #received = 0;

  push(msg: { text: string; chunk?: { id: string; i: number; n: number } }): string | null {
    const chunk = msg.chunk;
    if (!chunk) {
      this.#id = null;
      return msg.text;
    }
    if (!(chunk.n >= 1 && chunk.i >= 0 && chunk.i < chunk.n)) return null;
    if (this.#id !== chunk.id || this.#parts.length !== chunk.n) {
      this.#id = chunk.id;
      this.#parts = new Array<string>(chunk.n);
      this.#received = 0;
    }
    if (this.#parts[chunk.i] === undefined) {
      this.#parts[chunk.i] = msg.text;
      this.#received += 1;
    }
    if (this.#received < chunk.n) return null;
    const full = this.#parts.join("");
    this.#id = null;
    this.#parts = [];
    this.#received = 0;
    return full;
  }
}

/**
 * 高频输入节流：间隔内只保留最新值，结束时补发尾帧，保证最终位置准确。
 */
export class TrailingThrottle<T> {
  readonly #intervalMs: number;
  readonly #send: (value: T) => void;
  readonly #now: () => number;
  #lastAt = Number.NEGATIVE_INFINITY;
  #pending: T | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(intervalMs: number, send: (value: T) => void, now: () => number = () => performance.now()) {
    this.#intervalMs = intervalMs;
    this.#send = send;
    this.#now = now;
  }

  push(value: T): void {
    const now = this.#now();
    if (now - this.#lastAt >= this.#intervalMs && this.#timer === null) {
      this.#lastAt = now;
      this.#send(value);
      return;
    }
    this.#pending = value;
    if (this.#timer === null) {
      const wait = Math.max(0, this.#intervalMs - (now - this.#lastAt));
      this.#timer = setTimeout(() => this.flush(), wait);
    }
  }

  /** 立即发出挂起的值（点击前调用，保证按下位置与移动顺序一致）。 */
  flush(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const value = this.#pending;
    this.#pending = null;
    if (value !== null) {
      this.#lastAt = this.#now();
      this.#send(value);
    }
  }

  cancel(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending = null;
  }
}

export interface RemoteKeyCombo {
  id: string;
  /** 依次按下、逆序抬起的物理键码。 */
  codes: string[];
}

/** 浏览器或本机系统会拦截、无法直接按出的远端组合键。 */
export const REMOTE_KEY_COMBOS: readonly RemoteKeyCombo[] = [
  { id: "appSwitcher", codes: ["MetaLeft", "Tab"] },
  { id: "spotlight", codes: ["MetaLeft", "Space"] },
  { id: "inputSource", codes: ["ControlLeft", "Space"] },
  { id: "missionControl", codes: ["ControlLeft", "ArrowUp"] },
  { id: "showDesktop", codes: ["MetaLeft", "F3"] },
  { id: "forceQuit", codes: ["MetaLeft", "AltLeft", "Escape"] },
  { id: "lockScreen", codes: ["ControlLeft", "MetaLeft", "KeyQ"] },
  { id: "screenshot", codes: ["MetaLeft", "ShiftLeft", "Digit5"] },
  { id: "closeWindow", codes: ["MetaLeft", "KeyW"] },
  { id: "quitApp", codes: ["MetaLeft", "KeyQ"] },
  { id: "hideApp", codes: ["MetaLeft", "KeyH"] },
];

const MODIFIER_FLAG: Record<string, keyof KeyModifierFlags> = {
  MetaLeft: "meta",
  MetaRight: "meta",
  ControlLeft: "ctrl",
  ControlRight: "ctrl",
  AltLeft: "alt",
  AltRight: "alt",
  ShiftLeft: "shift",
  ShiftRight: "shift",
};

/** 把组合键展开成带明确修饰键状态的 kd/ku 序列。 */
export function expandKeyCombo(
  codes: readonly string[],
): Array<{ t: "kd" | "ku"; code: string } & Required<KeyModifierFlags>> {
  const held: Required<KeyModifierFlags> = { meta: false, ctrl: false, alt: false, shift: false };
  const out: Array<{ t: "kd" | "ku"; code: string } & Required<KeyModifierFlags>> = [];
  for (const code of codes) {
    const flag = MODIFIER_FLAG[code];
    if (flag) held[flag] = true;
    out.push({ t: "kd", code, ...held });
  }
  for (const code of [...codes].reverse()) {
    const flag = MODIFIER_FLAG[code];
    if (flag) held[flag] = false;
    out.push({ t: "ku", code, ...held });
  }
  return out;
}

export interface InboundVideoSample {
  at: number;
  bytes: number;
  frames: number;
  packetsLost: number;
  packetsReceived: number;
  jitterDelay: number;
  jitterEmitted: number;
  decodeTime: number;
}

export interface RemoteDesktopStatsView {
  fps: number | null;
  bitrateBps: number | null;
  lossPct: number | null;
  rttMs: number | null;
  jitterBufferMs: number | null;
  decodeMs: number | null;
  relay: boolean | null;
  width: number | null;
  height: number | null;
}

/** 从 `RTCPeerConnection.getStats()` 结果里提炼接收端关键指标。 */
export function summarizeRtcStats(
  report: Iterable<Record<string, unknown>>,
  previous: InboundVideoSample | null,
  nowMs: number,
): { view: RemoteDesktopStatsView; sample: InboundVideoSample | null } {
  const byId = new Map<string, Record<string, unknown>>();
  let inbound: Record<string, unknown> | null = null;
  let pair: Record<string, unknown> | null = null;
  let transport: Record<string, unknown> | null = null;
  for (const entry of report) {
    const id = typeof entry.id === "string" ? entry.id : "";
    if (id) byId.set(id, entry);
    if (entry.type === "inbound-rtp" && (entry.kind === "video" || entry.mediaType === "video")) inbound = entry;
    if (entry.type === "transport") transport = entry;
    if (entry.type === "candidate-pair" && (entry.selected === true || entry.nominated === true) && entry.state === "succeeded") {
      pair = pair ?? entry;
    }
  }
  if (transport && typeof transport.selectedCandidatePairId === "string") {
    pair = byId.get(transport.selectedCandidatePairId) ?? pair;
  }
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const view: RemoteDesktopStatsView = {
    fps: null,
    bitrateBps: null,
    lossPct: null,
    rttMs: null,
    jitterBufferMs: null,
    decodeMs: null,
    relay: null,
    width: null,
    height: null,
  };
  if (pair) {
    const rtt = num(pair.currentRoundTripTime);
    if (rtt !== null) view.rttMs = Math.round(rtt * 1000);
    const local = typeof pair.localCandidateId === "string" ? byId.get(pair.localCandidateId) : undefined;
    const remote = typeof pair.remoteCandidateId === "string" ? byId.get(pair.remoteCandidateId) : undefined;
    if (local || remote) {
      view.relay = local?.candidateType === "relay" || remote?.candidateType === "relay";
    }
  }
  if (!inbound) return { view, sample: null };
  const sample: InboundVideoSample = {
    at: nowMs,
    bytes: num(inbound.bytesReceived) ?? 0,
    frames: num(inbound.framesDecoded) ?? 0,
    packetsLost: num(inbound.packetsLost) ?? 0,
    packetsReceived: num(inbound.packetsReceived) ?? 0,
    jitterDelay: num(inbound.jitterBufferDelay) ?? 0,
    jitterEmitted: num(inbound.jitterBufferEmittedCount) ?? 0,
    decodeTime: num(inbound.totalDecodeTime) ?? 0,
  };
  view.width = num(inbound.frameWidth);
  view.height = num(inbound.frameHeight);
  const fps = num(inbound.framesPerSecond);
  if (previous && nowMs > previous.at) {
    const seconds = (nowMs - previous.at) / 1000;
    const frames = sample.frames - previous.frames;
    view.fps = fps ?? Math.max(0, Math.round(frames / seconds));
    view.bitrateBps = Math.max(0, Math.round(((sample.bytes - previous.bytes) * 8) / seconds));
    const lost = sample.packetsLost - previous.packetsLost;
    const got = sample.packetsReceived - previous.packetsReceived;
    view.lossPct = lost + got > 0 ? Math.max(0, Math.round((lost / (lost + got)) * 1000) / 10) : 0;
    const emitted = sample.jitterEmitted - previous.jitterEmitted;
    if (emitted > 0) {
      view.jitterBufferMs = Math.round(((sample.jitterDelay - previous.jitterDelay) / emitted) * 1000);
    }
    if (frames > 0) {
      view.decodeMs = Math.round(((sample.decodeTime - previous.decodeTime) / frames) * 10000) / 10;
    }
  } else if (fps !== null) {
    view.fps = Math.round(fps);
  }
  return { view, sample };
}

/** 码率的人类可读形式。 */
export function formatBitrate(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}

/** 将 `Receiver` 播放缓冲压至 0，消除 WebRTC 默认抖动缓冲延迟。 */
export function applyZeroPlayoutDelay(receiver: RTCRtpReceiver): void {
  const target = receiver as RTCRtpReceiver & {
    playoutDelayHint?: number;
    jitterBufferTarget?: number;
  };
  try {
    target.playoutDelayHint = 0;
  } catch {
    // 部分浏览器只读或不支持时忽略。
  }
  try {
    target.jitterBufferTarget = 0;
  } catch {
    // Safari / 旧版 Chromium 不支持 jitterBufferTarget 时忽略。
  }
}
