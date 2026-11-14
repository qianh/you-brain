type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Run before mounting a new dsh iframe, including after a daemon-managed restart. */
export function createDshCookiePreparer(invoke: Invoke | undefined): (url: string) => Promise<void> {
  let preparedHost: string | undefined;
  let pending: { host: string; promise: Promise<void> } | undefined;
  return async (url) => {
    if (!invoke) return;
    const target = new URL(url);
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") {
      throw new Error("无效的 dsh 本地地址");
    }
    const host = target.host;
    if (host === preparedHost) return;
    if (pending?.host === host) return pending.promise;
    const promise = (async () => {
      // Matches dsh's HTTP requestAudience/cookieName; no token crosses the bridge.
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(host));
      const hash = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
      await invoke("prepare_dsh_cookies", { keepCookieName: `dsh-auth-${hash}` });
      preparedHost = host;
    })();
    pending = { host, promise };
    try {
      await promise;
    } finally {
      if (pending?.promise === promise) pending = undefined;
    }
  };
}
