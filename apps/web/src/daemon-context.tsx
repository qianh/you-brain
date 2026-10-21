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

import { BrowserDaemonError, createBrowserDaemon, type BrowserDaemon } from "./api/client.js";
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

export function DaemonProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => createBrowserDaemon(), []);
  const [snapshot, setSnapshot] = useState<DaemonSnapshot>({
    config: null,
    roles: null,
    today: null,
    topics: [],
    devices: [],
    status: null,
    reminders: [],
  });
  const [language, setLanguageState] = useState<Language>("zh");
  const languageRef = useRef<Language>("zh");
  const userChoseLanguage = useRef(false);
  const [loading, setLoading] = useState(true);
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
    async (scope: "today" | "topics" | "status" | "all" = "all"): Promise<boolean> => {
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
          setSnapshot({
            config,
            roles,
            today,
            topics: topics.topics,
            devices: devices.devices,
            status,
            reminders: reminders.reminders,
          });
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
            if (event.kind === "ready") return;
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

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }, [language]);

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
