/**
 * 按需加载的页面块加载失败时刷新一次页面。
 *
 * 升级 App 会整体替换 web 目录，旧文件名的块随之消失；已经打开的窗口再去加载没加载过的块就会 404，
 * React 会把整页卸掉。刷新一次就能拿到新版本。10 秒内已经因此刷新过就不再刷新，把错误抛出去，
 * 避免网络真的不通时反复刷新。
 */
const RELOADED_AT_KEY = "you-brain:chunk-reload-at";
const RETRY_WINDOW_MS = 10_000;

export interface ChunkReloadEnv {
  now(): number;
  read(): string | null;
  write(value: string): void;
  reload(): void;
}

const browserEnv: ChunkReloadEnv = {
  now: () => Date.now(),
  read: () => {
    try { return window.sessionStorage.getItem(RELOADED_AT_KEY); } catch { return null; }
  },
  write: (value) => {
    try { window.sessionStorage.setItem(RELOADED_AT_KEY, value); } catch { /* 存不了也照常刷新。 */ }
  },
  reload: () => window.location.reload(),
};

export function loadChunk<T>(load: () => Promise<T>, env: ChunkReloadEnv = browserEnv): Promise<T> {
  return load().catch((error: unknown) => {
    const last = Number(env.read());
    if (!Number.isFinite(last) || env.now() - last > RETRY_WINDOW_MS) {
      env.write(String(env.now()));
      env.reload();
      // 页面马上刷新；不让 React 在这之前渲染错误。
      return new Promise<T>(() => undefined);
    }
    throw error;
  });
}
