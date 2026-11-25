/**
 * 按链路选择采集/编码档位：走 TURN 中继时带宽小、RTT 高，降帧率和分辨率换取更低码率下的清晰度与稳定性。
 *
 * - direct：直连，按画质预设输出；
 * - relay：中继，分辨率上限 1440、30fps；
 * - relay-low：中继且自适应码率很低，分辨率上限 1152、24fps。
 *
 * 分辨率变化会重建编码会话并产生关键帧，因此 relay 与 relay-low 之间带回差和最短停留时间，避免来回抖动。
 */
export type StreamTier = "direct" | "relay" | "relay-low";

export interface StreamProfile {
  maxDimension: number;
  fps: number;
}

export const RELAY_PROFILE: StreamProfile = { maxDimension: 1440, fps: 30 };
export const RELAY_LOW_PROFILE: StreamProfile = { maxDimension: 1152, fps: 24 };
/** 码率低于该值进入 relay-low。 */
export const RELAY_LOW_ENTER_BPS = 1_000_000;
/** 码率高于该值退出 relay-low。 */
export const RELAY_LOW_EXIT_BPS = 1_600_000;
/** relay 与 relay-low 之间两次切换的最短间隔。 */
export const TIER_MIN_DWELL_MS = 10_000;

export function nextStreamTier(input: {
  current: StreamTier;
  relay: boolean;
  targetBps: number;
  nowMs: number;
  changedAtMs: number;
}): StreamTier {
  const { current, relay, targetBps, nowMs, changedAtMs } = input;
  if (!relay) return "direct";
  if (current === "direct") return targetBps < RELAY_LOW_ENTER_BPS ? "relay-low" : "relay";
  const dwellOk = nowMs - changedAtMs >= TIER_MIN_DWELL_MS;
  if (current === "relay" && targetBps < RELAY_LOW_ENTER_BPS && dwellOk) return "relay-low";
  if (current === "relay-low" && targetBps > RELAY_LOW_EXIT_BPS && dwellOk) return "relay";
  return current;
}

/** 档位叠加到画质预设上：只会收紧，不会超过用户所选画质本身的分辨率与帧率。 */
export function streamProfileFor(tier: StreamTier, preset: StreamProfile): StreamProfile {
  const cap = tier === "relay" ? RELAY_PROFILE : tier === "relay-low" ? RELAY_LOW_PROFILE : null;
  if (!cap) return { maxDimension: preset.maxDimension, fps: preset.fps };
  return {
    maxDimension: Math.min(preset.maxDimension, cap.maxDimension),
    fps: Math.min(preset.fps, cap.fps),
  };
}
