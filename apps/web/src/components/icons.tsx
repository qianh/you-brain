import type { ReactNode } from "react";

export type IconName =
  | "refresh"
  | "settings"
  | "search"
  | "chevron"
  | "chevronUp"
  | "check"
  | "plus"
  | "laptop"
  | "server"
  | "book"
  | "user"
  | "inbox"
  | "alert"
  | "calendar"
  | "pulse"
  | "sun"
  | "moon"
  | "monitor";

const PATHS: Record<IconName, ReactNode> = {
  refresh: (
    <>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.4-5.9" />
      <path d="M20.5 4.5V9H16" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3V20.5M3.5 12h2.2M18.3 12H20.5M5.8 5.8l1.6 1.6M16.6 16.6l1.6 1.6M18.2 5.8l-1.6 1.6M7.4 16.6l-1.6 1.6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16.5 20 20.5" />
    </>
  ),
  chevron: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  chevronUp: <path d="m6.5 14.5 5.5-5.5 5.5 5.5" />,
  check: <path d="m5 12.5 4.2 4.2L19 7.2" />,
  plus: (
    <>
      <path d="M12 5.5v13" />
      <path d="M5.5 12h13" />
    </>
  ),
  laptop: (
    <>
      <rect x="4" y="5" width="16" height="11" rx="1.5" />
      <path d="M3 18.5h18" />
    </>
  ),
  server: (
    <>
      <rect x="4" y="4" width="16" height="6" rx="1.5" />
      <rect x="4" y="14" width="16" height="6" rx="1.5" />
      <path d="M8 7h.01M8 17h.01" />
    </>
  ),
  book: (
    <>
      <path d="M5 5.5h6.2A2.8 2.8 0 0 1 14 8.3V19a2.2 2.2 0 0 0-2.2-2.2H5z" />
      <path d="M19 5.5h-6.2A2.8 2.8 0 0 0 10 8.3V19a2.2 2.2 0 0 1 2.2-2.2H19z" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3" />
      <path d="M5.5 19.2a6.5 6.5 0 0 1 13 0" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 13.5 6.2 5.5h11.6L20 13.5" />
      <path d="M4 13.5h4.2l1 2h5.6l1-2H20V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.5 20.5 19H3.5z" />
      <path d="M12 10v4.2" />
      <path d="M12 16.8h.01" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14" rx="2" />
      <path d="M8 3.8v3.2M16 3.8v3.2M4 10h16" />
    </>
  ),
  pulse: <path d="M3 12h4l2.2-5 3.2 10L15 12h6" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3.8v1.8M12 18.4v1.8M3.8 12h1.8M18.4 12h1.8M6.1 6.1l1.3 1.3M16.6 16.6l1.3 1.3M17.9 6.1l-1.3 1.3M7.4 16.6l-1.3 1.3" />
    </>
  ),
  moon: <path d="M16.5 14.2A6.2 6.2 0 0 1 9.8 6 6.4 6.4 0 1 0 16.5 14.2z" />,
  monitor: (
    <>
      <rect x="3.5" y="4.5" width="17" height="12" rx="2" />
      <path d="M9 19.5h6M12 16.5v3" />
    </>
  ),
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
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

const SOURCE_MARKS: Record<string, string> = {
  "claude-code": "Cl",
  codex: "Cx",
  "grok-build": "Gk",
  cursor: "Cu",
  "gemini-cli": "Gm",
};

export function SourceMark({ source }: { source: string }) {
  const known = SOURCE_MARKS[source];
  const parts = source.split(/[-_\s]+/u).filter((part) => part !== "");
  const fallback =
    parts.length >= 2
      ? `${parts[0]?.slice(0, 1) ?? ""}${parts[1]?.slice(0, 1) ?? ""}`.toUpperCase()
      : source.trim().slice(0, 2).toUpperCase();
  return (
    <span className="mark" aria-hidden="true">
      {known ?? (fallback === "" ? "·" : fallback)}
    </span>
  );
}
