import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ReminderView, StatusResponse, TodayResponse, TopicListItem } from "@you-brain/core/http/types.js";
import type { DeviceRecord, Roles, SharedConfig } from "@you-brain/protocol";

import {
  BrowserDaemonError,
  createBrowserDaemon,
  type BrowserDaemon,
  type ReminderActionName,
} from "./api/client.js";
import { driveStillChecking } from "./lib/drive-state.js";
import type { Language } from "./lib/format.js";
import { translate, type MessageKey } from "./i18n/messages.js";

export interface DaemonSnapshot {
  config: SharedConfig | null;
  roles: Roles | null;
  today: TodayResponse | null;
  topics: TopicListItem[];
  devices: DeviceRecord[];
  status: StatusResponse | null;
  reminders: ReminderView[];
}

const BOOT_SNAPSHOT_KEY = "you-brain.boot-snapshot";

/**
 * 上次成功启动的快照持久化在 localStorage:再次打开时先用它渲染
 * (stale-while-revalidate),boot 屏只在第一次真的没有缓存时出现。
 */
function readBootSnapshot(): DaemonSnapshot | null {
  try {
    const raw = localStorage.getItem(BOOT_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DaemonSnapshot> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.config || !parsed.roles || !parsed.status) return null;
    return {
      config: parsed.config,
      roles: parsed.roles,
      today: parsed.today ?? null,
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      status: parsed.status,
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
    };
  } catch {
    return null;
  }
}

function writeBootSnapshot(snapshot: DaemonSnapshot): void {
  try {
    if (!snapshot.config || !snapshot.roles || !snapshot.status) return;
    localStorage.setItem(BOOT_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // 存不下就算了(隐私模式/超限),只影响下次启动的秒开。
  }
}

interface DaemonValue extends DaemonSnapshot {
  client: BrowserDaemon;
  language: Language;
  setLanguage: (language: Language) => void;
  loading: boolean;
  error: string | null;
  streamError: string | null;
  detailRevision: number;
  timeZone: string;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  reload: (scope?: "today" | "topics" | "status" | "all") => Promise<boolean>;
  reminderAction: (reminderId: string, action: ReminderActionName, until?: string) => Promise<void>;
  replaceConfig: (config: SharedConfig) => void;
  replaceRoles: (roles: Roles) => void;
}

const DaemonContext = createContext<DaemonValue | null>(null);

function errorText(error: unknown, language: Language): string {
  if (error instanceof BrowserDaemonError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "";
  if (error instanceof Error && error.message) return error.message;
  return translate(language, "loadFailed");
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

const DRIVE_CHECK_POLL_MS = 3000;

export function DaemonProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => createBrowserDaemon(), []);
  const hydrated = useMemo(() => readBootSnapshot(), []);
  const [snapshot, setSnapshot] = useState<DaemonSnapshot>(
    hydrated ?? {
      config: null,
      roles: null,
      today: null,
      topics: [],
      devices: [],
      status: null,
      reminders: [],
    },
  );
  const [language, setLanguageState] = useState<Language>("zh");
  const languageRef = useRef<Language>("zh");
  const userChoseLanguage = useRef(false);
  // 有缓存快照就不挡 boot 屏:后台刷新会在数据到达后覆盖。
  const [loading, setLoading] = useState(hydrated === null);
  const [error, setError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const alive = useRef(true);

  const setLanguage = useCallback((next: Language) => {
    userChoseLanguage.current = true;
    languageRef.current = next;
    setLanguageState(next);
  }, []);

  const applyLanguage = useCallback((config: SharedConfig | null) => {
    if (!config || userChoseLanguage.current) return;
    languageRef.current = config.ui.language;
    setLanguageState(config.ui.language);
  }, []);

  const reload = useCallback(
    async (
      scope: "today" | "topics" | "status" | "devices" | "all" = "all",
    ): Promise<boolean> => {
      const currentLanguage = languageRef.current;
      try {
        if (scope === "all") {
          const [config, roles, today, topics, devices, status, reminders] = await Promise.all([
            client.config(),
            client.roles(),
            client.today(),
            client.topics(),
            client.devices(),
            client.status(),
            client.reminders(),
          ]);
          if (!alive.current) return false;
          applyLanguage(config);
          const next: DaemonSnapshot = {
            config,
            roles,
            today,
            topics: topics.topics,
            devices: devices.devices,
            status,
            reminders: reminders.reminders,
          };
          setSnapshot(next);
          writeBootSnapshot(next);
          setError(null);
          return true;
        }
        if (scope === "today") {
          const today = await client.today();
          if (!alive.current) return false;
          setSnapshot((current) => ({ ...current, today }));
          setDetailRevision((value) => value + 1);
          return true;
        }
        if (scope === "topics") {
          const topics = await client.topics();
          if (!alive.current) return false;
          setSnapshot((current) => ({ ...current, topics: topics.topics }));
          setDetailRevision((value) => value + 1);
          return true;
        }
        if (scope === "devices") {
          const devices = await client.devices();
          if (!alive.current) return false;
          setSnapshot((current) => ({ ...current, devices: devices.devices }));
          return true;
        }
        const [status, reminders] = await Promise.all([client.status(), client.reminders()]);
        if (!alive.current) return false;
        setSnapshot((current) => ({ ...current, status, reminders: reminders.reminders }));
        return true;
      } catch (caught) {
        if (!alive.current) return false;
        const message = errorText(caught, currentLanguage);
        if (message) setError(message);
        return false;
      }
    },
    [applyLanguage, client],
  );

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void (async () => {
      await reload("all");
      if (alive.current) setLoading(false);
      while (alive.current && !controller.signal.aborted) {
        try {
          await client.events((event) => {
            if (event.kind === "ready" || event.kind === "portrait") return;
            // 知识库页自己管理刷新;这里只处理会话域的变更。
            if (event.kind === "notion") return;
            void reload(event.kind);
          }, { signal: controller.signal });
          setStreamError(null);
        } catch (caught) {
          if (!alive.current || controller.signal.aborted) return;
          const message = errorText(caught, languageRef.current);
          if (message) setStreamError(message);
        }
        if (!alive.current || controller.signal.aborted) return;
        await pause(2000, controller.signal);
      }
    })();
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [client, reload]);

  // The daemon announces when its Drive check ends. Polling covers a missed announcement.
  const driveChecking = driveStillChecking(snapshot.status);
  useEffect(() => {
    if (!driveChecking) return;
    const timer = setInterval(() => {
      void reload("status");
    }, DRIVE_CHECK_POLL_MS);
    return () => clearInterval(timer);
  }, [driveChecking, reload]);

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }, [language]);

  const reminderAction = useCallback(
    async (reminderId: string, action: ReminderActionName, until?: string): Promise<void> => {
      await client.reminderAction(reminderId, action, until);
      await reload("status");
    },
    [client, reload],
  );

  const timeZone = snapshot.roles?.timezone || snapshot.today?.timeZone || "Asia/Shanghai";
  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => translate(language, key, vars),
    [language],
  );

  const value = useMemo<DaemonValue>(
    () => ({
      ...snapshot,
      client,
      language,
      setLanguage,
      loading,
      error,
      streamError,
      detailRevision,
      timeZone,
      t,
      reload,
      reminderAction,
      replaceConfig: (config) => {
        applyLanguage(config);
        setSnapshot((current) => ({ ...current, config }));
      },
      replaceRoles: (roles) => setSnapshot((current) => ({ ...current, roles })),
    }),
    [
      snapshot,
      client,
      language,
      setLanguage,
      loading,
      error,
      streamError,
      detailRevision,
      timeZone,
      t,
      reload,
      reminderAction,
      applyLanguage,
    ],
  );

  return <DaemonContext.Provider value={value}>{children}</DaemonContext.Provider>;
}

export function useDaemon(): DaemonValue {
  const value = useContext(DaemonContext);
  if (!value) throw new Error("useDaemon must be used inside DaemonProvider");
  return value;
}
