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
  const dx = Math.round(-deltaX * scale);
  const dy = Math.round(-deltaY * scale);
  return {
    dx: dx === 0 ? 0 : Math.max(-2400, Math.min(2400, dx)),
    dy: dy === 0 ? 0 : Math.max(-2400, Math.min(2400, dy)),
  };
}

/** 提取键盘事件上的修饰键标记。 */
export function extractModifiers(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): KeyModifierFlags {
  return {
    ...(event.metaKey ? { meta: true } : {}),
    ...(event.ctrlKey ? { ctrl: true } : {}),
    ...(event.altKey ? { alt: true } : {}),
    ...(event.shiftKey ? { shift: true } : {}),
  };
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
