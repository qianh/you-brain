/**
 * 界面偏好存储：同步读、延迟合并写。
 *
 * 网页从 http://127.0.0.1:<随机端口>/ 加载，daemon 每次重启端口都会变，
 * 浏览器 origin 跟着变，localStorage 就丢了。所以偏好改由 daemon 保存：
 * 首屏时 daemon 把全部偏好注入 `window.__YOU_BRAIN__.prefs`，这里同步读内存副本；
 * 写入先更新内存副本，再延迟合并成一次 `PUT /api/ui-prefs`。
 *
 * 本模块只认键和值，不含任何业务名词；哪些键算偏好由 `isPrefKey` 决定。
 * 它不依赖 React 上下文（theme.ts 等非 React 代码也要用）。
 */

export interface PrefsStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PrefsPatch {
  set?: Record<string, string>;
  remove?: string[];
}

export interface PushOptions {
  keepalive?: boolean;
}

type LegacyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface CreatePrefsOptions {
  /** daemon 注入的偏好；为 null 表示没有注入（例如 vite 开发模式），整体退回 legacy。 */
  initial: Record<string, string> | null;
  /** `keepalive` 仅在页面关闭时的最后一次写入为 true；普通写入不带。 */
  push(patch: PrefsPatch, options?: PushOptions): Promise<unknown>;
  /** 旧的浏览器存储，用于首次迁移和无注入时的回退；不可用时为 null。 */
  legacy: LegacyStorage | null;
  isPrefKey(key: string): boolean;
  /** 列出 legacy 里现有的全部键，用于迁移。 */
  legacyKeys(): string[];
  onError(error: unknown): void;
  delayMs?: number;
}

const PREF_KEYS: ReadonlySet<string> = new Set([
  "you-brain-theme",
  "you-brain-today-mode",
  "you-brain.deck.view",
  "you-brain.deck.tty7-open",
  "you-brain.deck.t3-url",
  "you-brain.deck.tty7-harness",
  "you-brain.deck.tty7-active-only",
  "you-brain.deck.tty7-expanded",
  "you-brain.deck.tty7-group-colors",
  "you-brain:knowledge:collapsed:v1",
  "you-brain:knowledge:open-toggles:v1",
  "knowledge-sidebar-w",
  "knowledge-wide",
]);

const PREF_PREFIXES: readonly string[] = [
  "you-brain:knowledge:db-view:",
  "you-brain.deck.terminal-",
  "you-brain.memory.",
];

/** 是否属于要交给 daemon 保存的偏好键。缓存、启动快照等不是偏好，仍留在 localStorage。 */
export function isPrefKey(key: string): boolean {
  return PREF_KEYS.has(key) || PREF_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function createPrefs(options: CreatePrefsOptions): PrefsStore & { flush(options?: PushOptions): Promise<void> } {
  const delayMs = options.delayMs ?? 300;
  const { initial, legacy } = options;

  // 没有注入：整体退回 legacy 读写，不推送。legacy 也不可用时只在内存里保存。
  if (initial === null) {
    const memory = new Map<string, string>();
    return {
      getItem(key) {
        try {
          return legacy ? legacy.getItem(key) : (memory.get(key) ?? null);
        } catch {
          return memory.get(key) ?? null;
        }
      },
      setItem(key, value) {
        memory.set(key, value);
        try {
          legacy?.setItem(key, value);
        } catch {
          // 存不了就只留在内存。
        }
      },
      removeItem(key) {
        memory.delete(key);
        try {
          legacy?.removeItem(key);
        } catch {
          // 同上。
        }
      },
      async flush() {},
    };
  }

  const cache = new Map<string, string>(Object.entries(initial));
  const pendingSet = new Map<string, string>();
  const pendingRemove = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const schedule = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
  };

  const flush = (flushOptions?: PushOptions): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendingSet.size === 0 && pendingRemove.size === 0) return chain;
    const patch: PrefsPatch = {};
    if (pendingSet.size > 0) patch.set = Object.fromEntries(pendingSet);
    if (pendingRemove.size > 0) patch.remove = [...pendingRemove];
    pendingSet.clear();
    pendingRemove.clear();
    // 串行发送，保证先后顺序；失败只报告，不阻断后续写入。
    chain = chain.then(async () => {
      try {
        await options.push(patch, flushOptions);
      } catch (error) {
        options.onError(error);
      }
    });
    return chain;
  };

  // 首次启动：legacy 里有、daemon 里没有的偏好键迁移过来（不删 legacy 原值）。
  if (legacy !== null) {
    try {
      for (const key of options.legacyKeys()) {
        if (!options.isPrefKey(key) || cache.has(key)) continue;
        const value = legacy.getItem(key);
        if (value === null) continue;
        cache.set(key, value);
        pendingSet.set(key, value);
      }
    } catch {
      // legacy 读不了就跳过迁移。
    }
    if (pendingSet.size > 0) schedule();
  }

  return {
    getItem(key) {
      return cache.get(key) ?? null;
    },
    setItem(key, value) {
      cache.set(key, value);
      pendingRemove.delete(key);
      pendingSet.set(key, value);
      schedule();
    },
    removeItem(key) {
      cache.delete(key);
      pendingSet.delete(key);
      pendingRemove.add(key);
      schedule();
    },
    flush,
  };
}

function browserLegacy(): LegacyStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function browserLegacyKeys(): string[] {
  const storage = browserLegacy();
  if (storage === null || !("length" in storage)) return [];
  const full = storage as Storage;
  const keys: string[] = [];
  for (let index = 0; index < full.length; index += 1) {
    const key = full.key(index);
    if (key !== null) keys.push(key);
  }
  return keys;
}

let warned = false;

/** 浏览器对 keepalive 请求体的上限是 64 KB，超过会直接抛 TypeError；留出余量。 */
const KEEPALIVE_MAX_BYTES = 60_000;

function createBrowserPrefs(): PrefsStore & { flush(options?: PushOptions): Promise<void> } {
  const bootstrap = typeof window === "undefined" ? undefined : window.__YOU_BRAIN__;
  const initial = bootstrap?.prefs !== undefined && typeof bootstrap.prefs === "object" ? bootstrap.prefs : null;
  const store = createPrefs({
    initial,
    legacy: browserLegacy(),
    isPrefKey,
    legacyKeys: browserLegacyKeys,
    delayMs: 300,
    push: async (patch, pushOptions) => {
      const body = JSON.stringify(patch);
      // 只有 pagehide 的最后一次写入才需要 keepalive；体积超限时退回普通请求（尽力发送，
      // 页面若已卸载可能被取消），也不能带 keepalive 否则 fetch 会直接拒绝。
      const keepalive = pushOptions?.keepalive === true && new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES;
      const response = await fetch("/api/ui-prefs", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bootstrap?.token ?? ""}`,
        },
        body,
        ...(keepalive ? { keepalive: true } : {}),
      });
      if (!response.ok) throw new Error(`保存偏好失败：HTTP ${response.status}`);
    },
    onError: (error) => {
      if (warned) return;
      warned = true;
      console.warn("界面偏好暂时无法保存，本次仍然有效", error);
      if (typeof window !== "undefined") window.dispatchEvent(new Event("you-brain:prefs-error"));
    },
  });
  if (typeof window !== "undefined" && initial !== null) {
    window.addEventListener("pagehide", () => {
      void store.flush({ keepalive: true });
    });
  }
  return store;
}

export const prefs: PrefsStore = createBrowserPrefs();
