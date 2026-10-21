/** URL switches such as `?open=palette` stay off the production UI. */
export function devOverlayAllowed(pathname: string, dev: boolean): boolean {
  return dev || pathname === "/_design";
}
