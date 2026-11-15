import type { DeckTty7SessionsResponse } from "@you-brain/core/http/types.js";

/** tty7 自己的终端字体设置（会话列表接口的 appearance）。 */
type Tty7Appearance = NonNullable<DeckTty7SessionsResponse["appearance"]>;

/** 记住用户在顶栏调过的终端字号；没有这个键就跟随 tty7。 */
export const FONT_SIZE_KEY = "you-brain.deck.terminal-font-size";
export const FONT_MIN = 9;
export const FONT_MAX = 24;

export interface TerminalAppearance {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

/** 读不到 tty7 配置时的回退值。 */
export const FALLBACK_APPEARANCE: TerminalAppearance = {
  fontFamily: '"SFMono-Regular", Menlo, Monaco, monospace',
  fontSize: 12,
  lineHeight: 1.2,
};

function storedFontSize(stored: string | null): number | null {
  if (stored === null || !/^\d+$/u.test(stored)) return null;
  const size = Number(stored);
  return size >= FONT_MIN && size <= FONT_MAX ? size : null;
}

/** 字体和行高取 tty7 的；字号优先取用户调过的（9～24 的整数），其次 tty7，最后回退值。 */
export function resolveAppearance(stored: string | null, tty7: Tty7Appearance | null): TerminalAppearance {
  return {
    fontFamily: tty7?.fontFamily ?? FALLBACK_APPEARANCE.fontFamily,
    fontSize: storedFontSize(stored) ?? tty7?.fontSize ?? FALLBACK_APPEARANCE.fontSize,
    lineHeight: tty7?.lineHeight ?? FALLBACK_APPEARANCE.lineHeight,
  };
}

export function stepFontSize(current: number, delta: 1 | -1): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, current + delta));
}
