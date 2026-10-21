import type { ReactNode } from "react";

export const ICON_NAMES = [
  "calendar",
  "book",
  "book-open",
  "activity",
  "inbox",
  "alert",
  "alert-circle",
  "check",
  "check-circle",
  "x",
  "x-circle",
  "search",
  "search-x",
  "sparkles",
  "user",
  "laptop",
  "server",
  "cloud",
  "plus",
  "minus",
  "external-link",
  "refresh",
  "settings",
  "chevron-right",
  "chevron-down",
  "chevron-up",
  "chevron-left",
  "copy",
  "pencil",
  "more",
  "key",
  "plug",
  "palette",
  "sliders",
  "globe",
  "bell",
  "shield",
  "cpu",
  "command",
  "arrow-up",
  "arrow-down",
  "corner-down-left",
  "sun",
  "moon",
  "monitor",
  "filter",
  "info",
  "clock",
  "link",
  "trash",
  "folder",
  "lock",
  "eye",
  "eye-off",
  "play",
  "terminal",
] as const;

export type CanonicalIcon = (typeof ICON_NAMES)[number];

/** Names already used by the current pages. */
export type IconAlias = "chevron" | "chevronUp" | "pulse";

export type IconName = CanonicalIcon | IconAlias;

const ALIAS: Record<IconAlias, CanonicalIcon> = {
  chevron: "chevron-down",
  chevronUp: "chevron-up",
  pulse: "activity",
};

const MARKUP: Record<CanonicalIcon, string> = {
  calendar: `<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M5 2.5v2M11 2.5v2M2.5 7h11"/>`,
  book: `<path d="M3 3.2h4.2A1.8 1.8 0 0 1 9 5v8.2A1.4 1.4 0 0 0 7.6 11.8H3z"/><path d="M13 3.2H8.8A1.8 1.8 0 0 0 7 5v8.2A1.4 1.4 0 0 1 8.4 11.8H13z"/>`,
  "book-open": `<path d="M8 4.2c-1.2-1-2.8-1.5-5-1.5v9.2c2.2 0 3.8.5 5 1.5 1.2-1 2.8-1.5 5-1.5V2.7c-2.2 0-3.8.5-5 1.5z"/><path d="M8 4.2v9.2"/>`,
  activity: `<path d="M2 8h2.4l1.6-3.2L8.6 11 10.2 8H14"/>`,
  inbox: `<path d="M2.5 9 4 3.5h8L13.5 9"/><path d="M2.5 9h3l.8 1.4h3.4L10.5 9h3V12.2a1.2 1.2 0 0 1-1.2 1.2H3.7a1.2 1.2 0 0 1-1.2-1.2z"/>`,
  alert: `<path d="M8 2.4 14.2 13.4H1.8z"/><path d="M8 6.4v3.2"/><path d="M8 11.4h.01"/>`,
  "alert-circle": `<circle cx="8" cy="8" r="5.5"/><path d="M8 5.2v3.3"/><path d="M8 10.8h.01"/>`,
  check: `<path d="m3.2 8.2 3 3.1 6.6-6.8"/>`,
  "check-circle": `<circle cx="8" cy="8" r="5.5"/><path d="m5.3 8.1 1.8 1.8 3.6-3.8"/>`,
  x: `<path d="m4 4 8 8M12 4 4 12"/>`,
  "x-circle": `<circle cx="8" cy="8" r="5.5"/><path d="m5.6 5.6 4.8 4.8M10.4 5.6 5.6 10.4"/>`,
  search: `<circle cx="7" cy="7" r="4"/><path d="m10.2 10.2 3 3"/>`,
  "search-x": `<circle cx="7" cy="7" r="4"/><path d="m10.2 10.2 3 3M5.6 5.6l2.8 2.8M8.4 5.6 5.6 8.4"/>`,
  sparkles: `<path d="M8 1.8 8.8 5 12 5.8 8.8 6.6 8 9.8 7.2 6.6 4 5.8 7.2 5z"/><path d="M12.2 9.2 12.6 10.6 14 11l-1.4.4-.4 1.4-.4-1.4L10.4 11l1.4-.4z"/>`,
  user: `<circle cx="8" cy="5.6" r="2.2"/><path d="M3.4 13.2a4.6 4.6 0 0 1 9.2 0"/>`,
  laptop: `<rect x="2.5" y="3.2" width="11" height="7.4" rx="1.2"/><path d="M1.8 12.6h12.4"/>`,
  server: `<rect x="2.5" y="2.4" width="11" height="4.4" rx="1"/><rect x="2.5" y="9.2" width="11" height="4.4" rx="1"/><path d="M5 4.6h.01M5 11.4h.01"/>`,
  cloud: `<path d="M5 12.2h6.1a2.6 2.6 0 0 0 .4-5.2 3.4 3.4 0 0 0-6.5 1.1A2.2 2.2 0 0 0 5 12.2z"/>`,
  plus: `<path d="M8 3.2v9.6M3.2 8h9.6"/>`,
  minus: `<path d="M3.2 8h9.6"/>`,
  "external-link": `<path d="M6.2 3.4H3.6v9h9V9.8"/><path d="M8.4 3.4H12.6V7.6"/><path d="M12.4 3.6 7.2 8.8"/>`,
  refresh: `<path d="M13.2 8A5.2 5.2 0 1 1 11.4 3.8"/><path d="M13.2 2.6V6H9.8"/>`,
  settings: `<circle cx="8" cy="8" r="2"/><path d="M8 2.2v1.6M8 12.2v1.6M2.2 8h1.6M12.2 8h1.6M3.9 3.9l1.1 1.1M11 11l1.1 1.1M12.1 3.9 11 5M5 11l-1.1 1.1"/>`,
  "chevron-right": `<path d="m6 3.5 4.5 4.5L6 12.5"/>`,
  "chevron-down": `<path d="m3.5 6 4.5 4.5L12.5 6"/>`,
  "chevron-up": `<path d="m3.5 10 4.5-4.5L12.5 10"/>`,
  "chevron-left": `<path d="m10 3.5-4.5 4.5L10 12.5"/>`,
  copy: `<rect x="5.2" y="5.2" width="7.4" height="7.4" rx="1.2"/><path d="M10.8 5.2V3.8A1.2 1.2 0 0 0 9.6 2.6H3.8A1.2 1.2 0 0 0 2.6 3.8v5.8a1.2 1.2 0 0 0 1.2 1.2h1.4"/>`,
  pencil: `<path d="m9.2 3.2 3.6 3.6L6.2 13.4 2.4 13.6l.2-3.8z"/><path d="m8.2 4.2 3.6 3.6"/>`,
  more: `<path d="M3.4 8h.01M8 8h.01M12.6 8h.01"/>`,
  key: `<circle cx="5.4" cy="8" r="2.4"/><path d="M7.6 8H14M11.6 8v2.2M13.4 8v1.4"/>`,
  plug: `<path d="M6 2.6v3.2M10 2.6v3.2"/><path d="M4.4 5.8h7.2v2.2a3.6 3.6 0 0 1-7.2 0z"/><path d="M8 11.6V14"/>`,
  palette: `<path d="M8 2.4a5.6 5.6 0 1 0 0 11.2h.8a1.4 1.4 0 0 0 0-2.8h-.4a1.2 1.2 0 0 1 0-2.4 3.2 3.2 0 0 0 0-6z"/><path d="M5.4 6.2h.01M6.6 4.4h.01M9.6 4.4h.01"/>`,
  sliders: `<path d="M3 4.2h10M3 8h10M3 11.8h10"/><path d="M6 4.2v.01M10 8v.01M7 11.8v.01"/>`,
  globe: `<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.6c1.6 1.6 2.4 3.4 2.4 5.4S9.6 11.8 8 13.4C6.4 11.8 5.6 10 5.6 8S6.4 4.2 8 2.6"/>`,
  bell: `<path d="M4.2 11.2h7.6l-.8-1.2V7.4a3 3 0 0 0-6 0v2.6z"/><path d="M6.8 12.4a1.2 1.2 0 0 0 2.4 0"/>`,
  shield: `<path d="M8 2.2 13 4.2v3.6c0 3-2 4.8-5 5.8-3-1-5-2.8-5-5.8V4.2z"/>`,
  cpu: `<rect x="4" y="4" width="8" height="8" rx="1.2"/><path d="M6.4 2.4v1.6M9.6 2.4v1.6M6.4 12v1.6M9.6 12v1.6M2.4 6.4H4M2.4 9.6H4M12 6.4h1.6M12 9.6h1.6"/>`,
  command: `<path d="M6 6h4v4H6z"/><path d="M6 6V4.6A1.6 1.6 0 1 0 4.4 6H6M10 6V4.6A1.6 1.6 0 1 1 11.6 6H10M6 10v1.4A1.6 1.6 0 1 1 4.4 10H6M10 10v1.4A1.6 1.6 0 1 0 11.6 10H10"/>`,
  "arrow-up": `<path d="M8 13V3.4M4.6 6.6 8 3.2l3.4 3.4"/>`,
  "arrow-down": `<path d="M8 3v9.6M4.6 9.4 8 12.8l3.4-3.4"/>`,
  "corner-down-left": `<path d="M13 4.2v4.2a2 2 0 0 1-2 2H3.6"/><path d="M6 7.8 3.2 10.6 6 13.4"/>`,
  sun: `<circle cx="8" cy="8" r="2.3"/><path d="M8 2.4v1.4M8 12.2v1.4M2.4 8h1.4M12.2 8h1.4M4 4l1 1M11 11l1 1M12 4l-1 1M5 11l-1 1"/>`,
  moon: `<path d="M10.6 2.8A5.2 5.2 0 1 0 13.2 10 4 4 0 0 1 10.6 2.8z"/>`,
  monitor: `<rect x="2.2" y="3" width="11.6" height="8" rx="1.2"/><path d="M6 13.4h4M8 11v2.4"/>`,
  filter: `<path d="M2.4 3.4h11.2l-4.2 5v3.6L6.6 13.4V8.4z"/>`,
  info: `<circle cx="8" cy="8" r="5.5"/><path d="M8 7.2V11"/><path d="M8 5.2h.01"/>`,
  clock: `<circle cx="8" cy="8" r="5.5"/><path d="M8 4.8V8l2.2 1.4"/>`,
  link: `<path d="M6.6 9.4 5.2 10.8a2.2 2.2 0 0 1-3.1-3.1L3.5 6.3a2.2 2.2 0 0 1 3.1 0"/><path d="M9.4 6.6 10.8 5.2a2.2 2.2 0 0 1 3.1 3.1L12.5 9.7a2.2 2.2 0 0 1-3.1 0"/>`,
  trash: `<path d="M3.2 4.4h9.6"/><path d="M6.2 4.4V3.2h3.6v1.2"/><path d="M4.4 4.4l.6 8.2h5.9l.6-8.2"/>`,
  folder: `<path d="M2.4 4.6h4l1.2 1.4h5.9v6.4H2.4z"/>`,
  lock: `<rect x="3.6" y="7" width="8.8" height="6.2" rx="1.2"/><path d="M5.4 7V5.4a2.6 2.6 0 0 1 5.2 0V7"/>`,
  eye: `<path d="M1.8 8S4 4.4 8 4.4 14.2 8 14.2 8 12 11.6 8 11.6 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.6"/>`,
  "eye-off": `<path d="M2.4 3.2 13.2 13"/><path d="M6.4 5.1A8 8 0 0 1 8 4.6c4 0 6.2 3.4 6.2 3.4a11 11 0 0 1-2.1 2.4"/><path d="M4.2 6.2C3 7.1 1.8 8 1.8 8S4 11.6 8 11.6a6 6 0 0 0 1.6-.2"/>`,
  play: `<path d="M5.2 3.6v8.8L12.6 8z"/>`,
  terminal: `<rect x="2.2" y="3" width="11.6" height="10" rx="1.4"/><path d="m4.6 6.2 2.2 1.8-2.2 1.8M8.4 10.2h3"/>`,
};

function canonical(name: IconName): CanonicalIcon {
  if (name in ALIAS) return ALIAS[name as IconAlias];
  return name as CanonicalIcon;
}

export function Icon({ name, size = 16 }: { name: IconName; size?: number }): ReactNode {
  const key = canonical(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: MARKUP[key] }}
    />
  );
}

export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="12" cy="12.33" r="3.85" fill="none" stroke="currentColor" strokeWidth="1.42" />
      <circle cx="12" cy="12.33" r="1.83" />
      <circle cx="12" cy="4.36" r="2.1" />
      <circle cx="19.57" cy="9.87" r="1.83" />
      <circle cx="16.68" cy="18.77" r="1.96" />
      <circle cx="7.32" cy="18.77" r="1.77" />
      <circle cx="4.43" cy="9.87" r="1.88" />
    </svg>
  );
}
