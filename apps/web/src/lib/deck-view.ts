/** 指挥台里的三个页面；指挥台页和别的页面左侧的快捷栏共用。 */
export const DECK_VIEWS = [
  { value: "t3", label: "T3" },
  { value: "dsh", label: "DSH" },
  { value: "muse", label: "Muse" },
] as const;

export type DeckView = (typeof DECK_VIEWS)[number]["value"];

/** 上次停在指挥台哪个页面。 */
export const DECK_VIEW_KEY = "you-brain.deck.view";

export function isDeckView(value: string | null): value is DeckView {
  return DECK_VIEWS.some((item) => item.value === value);
}

/** 跳到指挥台并切到指定页面；指挥台读到 view 后会把地址换回 /deck。 */
export function deckViewHref(view: DeckView): string {
  return `/deck?view=${view}`;
}
