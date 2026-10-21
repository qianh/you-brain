import type { ReactNode } from "react";

import { Icon, type IconName } from "./icons.js";

export type TileSize = "md" | "sm";

const SOURCES = ["claude-code", "codex", "grok-build", "cursor", "gemini-cli"] as const;
export type KnownSource = (typeof SOURCES)[number];

function isKnownSource(source: string): source is KnownSource {
  return (SOURCES as readonly string[]).includes(source);
}

function Glyph({ source }: { source: KnownSource }) {
  if (source === "claude-code") {
    const rays = Array.from({ length: 8 }, (_, index) => {
      const angle = (Math.PI * 2 * index) / 8;
      return (
        <line
          key={index}
          x1={8 + Math.cos(angle) * 2.1}
          y1={8 + Math.sin(angle) * 2.1}
          x2={8 + Math.cos(angle) * 6.1}
          y2={8 + Math.sin(angle) * 6.1}
        />
      );
    });
    return <g>{rays}</g>;
  }
  if (source === "codex") {
    return (
      <g>
        <path d="M3 4.6 6.6 8 3 11.4" />
        <path d="M8 11.5h4.6" />
      </g>
    );
  }
  if (source === "grok-build") {
    return (
      <g>
        <path d="M10.4 2.6 5.2 13.2" />
        <circle cx="11.7" cy="11.5" r="1.15" fill="currentColor" stroke="none" />
      </g>
    );
  }
  if (source === "cursor") {
    return (
      <g>
        <path d="M8 2.3 13 5v6L8 13.7 3 11V5z" />
        <path d="M8 2.3V8M8 8l5-3M8 8 3 5" />
      </g>
    );
  }
  return <path d="M8 1.8 9.4 6.6 14.2 8 9.4 9.4 8 14.2 6.6 9.4 1.8 8 6.6 6.6z" />;
}

export function SourceTile({
  source,
  size = "md",
  label,
}: {
  source: string;
  size?: TileSize;
  label?: string;
}) {
  const known = isKnownSource(source);
  const letter = (label ?? source).trim().slice(0, 1).toUpperCase() || "·";
  return (
    <span
      className={["tile", size === "sm" ? "sm" : "", known ? `source-${source}` : ""].filter(Boolean).join(" ")}
      aria-hidden="true"
      title={label}
    >
      {known ? (
        <svg width={size === "sm" ? 12 : 16} height={size === "sm" ? 12 : 16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <Glyph source={source} />
        </svg>
      ) : (
        <span className="tile-letter">{letter}</span>
      )}
    </span>
  );
}

/** @deprecated Use SourceTile. Kept so existing pages keep compiling. */
export function SourceMark({ source }: { source: string }) {
  return <SourceTile source={source} />;
}

const SWATCHES = 8;

export function swatchIndex(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % SWATCHES;
}

export function ProviderTile({
  provider,
  label,
  size = "md",
}: {
  provider: string;
  label?: string;
  size?: TileSize;
}) {
  const text = (label ?? provider).trim();
  const letter = text.slice(0, 1).toUpperCase() || "·";
  return (
    <span className={["tile", `swatch-${swatchIndex(provider) + 1}`, size === "sm" ? "sm" : ""].filter(Boolean).join(" ")} aria-hidden="true" title={text}>
      <span className="tile-letter">{letter}</span>
    </span>
  );
}

const DEVICE_ICON: Record<string, IconName> = {
  desktop: "laptop",
  server: "server",
  virtual: "cloud",
};

export function DeviceTile({
  kind,
  size = "md",
}: {
  kind: string;
  size?: TileSize;
}) {
  const icon = DEVICE_ICON[kind] ?? "laptop";
  return (
    <span className={["tile", "swatch-8", size === "sm" ? "sm" : ""].filter(Boolean).join(" ")} aria-hidden="true">
      <Icon name={icon} size={size === "sm" ? 12 : 16} />
    </span>
  );
}

export function Tile({ children, size = "md" }: { children: ReactNode; size?: TileSize }) {
  return <span className={size === "sm" ? "tile sm" : "tile"}>{children}</span>;
}
