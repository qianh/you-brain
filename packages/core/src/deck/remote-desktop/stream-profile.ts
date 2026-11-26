/**
 * 按链路选择采集/编码档位：走 TURN 中继时带宽小、RTT 高，降帧率和分辨率换取更低码率下的清晰度与稳定性。
 *
 * - direct：直连，按画质预设输出；
 * - relay-fast：中继但链路好（同城/国内中继，RTT 低且码率充足），与直连一样按画质预设输出；
 * - relay：中继，分辨率上限 1440、30fps；
 * - relay-low：中继且自适应码率很低，分辨率上限 1152、24fps。
 *
 * 分辨率变化会重建编码会话并产生关键帧，因此各中继档位之间带回差和最短停留时间，避免来回抖动。
 */
export type StreamTier = "direct" | "relay-fast" | "relay" | "relay-low";

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
/** 中继基线 RTT 不高于该值、且码率达到 RELAY_FAST_ENTER_BPS，才进入 relay-fast。 */
export const RELAY_FAST_ENTER_RTT_MS = 80;
export const RELAY_FAST_ENTER_BPS = 2_000_000;
/** 基线 RTT 超过该值或码率低于 RELAY_FAST_EXIT_BPS，退出 relay-fast。 */
export const RELAY_FAST_EXIT_RTT_MS = 150;
export const RELAY_FAST_EXIT_BPS = 1_200_000;
/** 中继档位之间两次切换的最短间隔。 */
export const TIER_MIN_DWELL_MS = 10_000;

export function nextStreamTier(input: {
  current: StreamTier;
  relay: boolean;
  targetBps: number;
  nowMs: number;
  changedAtMs: number;
  /** 中继链路的基线 RTT（毫秒）；未知时为 null，不会进入 relay-fast。 */
  rttMs?: number | null;
}): StreamTier {
  const { current, relay, targetBps, nowMs, changedAtMs } = input;
  const rttMs = input.rttMs ?? null;
  if (!relay) return "direct";
  if (current === "direct") return targetBps < RELAY_LOW_ENTER_BPS ? "relay-low" : "relay";
  const dwellOk = nowMs - changedAtMs >= TIER_MIN_DWELL_MS;
  if (!dwellOk) return current;
  const fastOk = rttMs !== null && rttMs <= RELAY_FAST_ENTER_RTT_MS && targetBps >= RELAY_FAST_ENTER_BPS;
  const fastBad = rttMs === null || rttMs > RELAY_FAST_EXIT_RTT_MS || targetBps < RELAY_FAST_EXIT_BPS;
  if (current === "relay-fast") return fastBad ? (targetBps < RELAY_LOW_ENTER_BPS ? "relay-low" : "relay") : current;
  if (current === "relay") {
    if (targetBps < RELAY_LOW_ENTER_BPS) return "relay-low";
    return fastOk ? "relay-fast" : current;
  }
  // relay-low
  return targetBps > RELAY_LOW_EXIT_BPS ? "relay" : current;
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
