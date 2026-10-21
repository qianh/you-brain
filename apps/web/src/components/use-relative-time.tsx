import { useEffect, useState } from "react";

import { formatRelative, type Language } from "../lib/format.js";

/** Re-renders once a minute so relative labels stay current. */
export function useRelativeTime(iso: string | null, language: Language, timeZone?: string): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return formatRelative(iso, language, timeZone, now);
}
