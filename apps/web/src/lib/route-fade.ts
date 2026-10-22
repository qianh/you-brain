import { useEffect, useState } from "react";

/** Longer than `--ease-pop` (160ms), so a missed `animationend` still drops `is-entering`. */
export const ROUTE_FADE_FALLBACK_MS = 220;

export interface RouteFadeEnv {
  reducedMotion: boolean;
  hidden: boolean;
}

export type RouteFadeSignal =
  | { type: "navigate"; env: RouteFadeEnv }
  | { type: "animationend" }
  | { type: "fallback" }
  | { type: "hide" }
  | { type: "show" }
  | { type: "blur" }
  | { type: "pagehide" }
  | { type: "reduce" };

/**
 * `is-entering` is only on while a visible, motion-enabled navigation is in flight.
 * Every other signal removes it, including the window coming back, so a paused
 * animation cannot leave the route stuck translucent.
 */
export function nextRouteFade(entering: boolean, signal: RouteFadeSignal): boolean {
  switch (signal.type) {
    case "navigate":
      return !signal.env.reducedMotion && !signal.env.hidden;
    case "animationend":
    case "fallback":
    case "hide":
    case "show":
    case "blur":
    case "pagehide":
    case "reduce":
      return false;
    default:
      return entering;
  }
}

/** Ignore animations that bubble from a child; only the route node itself ends the fade. */
export function routeFadeAnimationEnded(target: EventTarget | null, current: EventTarget | null): boolean {
  return target !== null && target === current;
}

export function useRouteEnter(pathname: string): { entering: boolean; clear: () => void } {
  const [entering, setEntering] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const env: RouteFadeEnv = {
      reducedMotion: media.matches,
      hidden: document.visibilityState === "hidden",
    };
    if (!nextRouteFade(false, { type: "navigate", env })) {
      setEntering(false);
      return;
    }
    setEntering(true);
    const stop = (): void => setEntering(false);
    const timer = window.setTimeout(() => {
      if (!nextRouteFade(true, { type: "fallback" })) stop();
    }, ROUTE_FADE_FALLBACK_MS);
    const onVisibility = (): void => {
      const type = document.visibilityState === "hidden" ? "hide" : "show";
      if (!nextRouteFade(true, { type })) stop();
    };
    const onBlur = (): void => {
      if (!nextRouteFade(true, { type: "blur" })) stop();
    };
    const onPageHide = (): void => {
      if (!nextRouteFade(true, { type: "pagehide" })) stop();
    };
    const onReduce = (): void => {
      if (media.matches && !nextRouteFade(true, { type: "reduce" })) stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pagehide", onPageHide);
    media.addEventListener("change", onReduce);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pagehide", onPageHide);
      media.removeEventListener("change", onReduce);
      setEntering(false);
    };
  }, [pathname]);
  return {
    entering,
    clear: () => {
      if (!nextRouteFade(true, { type: "animationend" })) setEntering(false);
    },
  };
}
