import type { WheelInputMessage } from "./types.js";

/** 单次应用的滚动量上限（像素），防止异常数据一次滚飞。 */
const MAX_WHEEL_STEP = 20_000;

/**
 * 把控制端的累计滚动总量还原成本次要滚的增量。
 *
 * 滚轮走不重传、不保序的通道：丢一条增量就永久少滚一段。新版控制端每条带累计总量与序号，
 * 这里用“新总量 − 上次总量”，中间丢掉的距离由下一条补回，晚到的旧序号直接丢弃。
 * 旧版控制端没有累计字段，原样使用 `dx/dy`。
 */
export class WheelStreamDecoder {
  #stream: { ws: string; seq: number; tx: number; ty: number } | null = null;

  /** 返回本次应滚动的增量；乱序旧包或无位移时返回 null。 */
  decode(msg: WheelInputMessage): { dx: number; dy: number } | null {
    let dx = Number.isFinite(msg.dx) ? msg.dx : 0;
    let dy = Number.isFinite(msg.dy) ? msg.dy : 0;
    const { ws, s, tx, ty } = msg;
    if (typeof ws === "string" && Number.isFinite(s) && Number.isFinite(tx) && Number.isFinite(ty)) {
      const prev = this.#stream;
      if (prev && prev.ws === ws) {
        if (s! <= prev.seq) return null;
        dx = tx! - prev.tx;
        dy = ty! - prev.ty;
      }
      this.#stream = { ws, seq: s!, tx: tx!, ty: ty! };
    }
    dx = Math.max(-MAX_WHEEL_STEP, Math.min(MAX_WHEEL_STEP, Math.round(dx * 100) / 100));
    dy = Math.max(-MAX_WHEEL_STEP, Math.min(MAX_WHEEL_STEP, Math.round(dy * 100) / 100));
    if (dx === 0 && dy === 0) return null;
    return { dx, dy };
  }
}
