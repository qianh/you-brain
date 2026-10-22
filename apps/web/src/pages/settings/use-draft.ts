import { useCallback, useEffect, useRef, useState } from "react";
import type { Roles, SharedConfig } from "@you-brain/protocol";

import { BrowserDaemonError } from "../../api/client.js";
import { useToast } from "../../components/toast.js";
import { useDaemon } from "../../daemon-context.js";
import type { MessageKey } from "../../i18n/messages.js";
import { validateSettings } from "../../lib/copy.js";
import {
  appearanceConfig,
  configSaveBody,
  isSettingsDirty,
  llmKeyPayload,
  oauthPayload,
  type OauthPayload,
} from "./logic.js";

export interface SettingsDraftApi {
  draft: SharedConfig | null;
  rolesDraft: Roles | null;
  issues: MessageKey[];
  apiKey: string;
  oauthMode: "official" | "custom";
  clientId: string;
  clientSecret: string;
  replacingKey: boolean;
  storedKeys: ReadonlySet<string>;
  busy: boolean;
  error: string | null;
  dirty: boolean;
  editDraft: (next: SharedConfig) => void;
  editRoles: (next: Roles) => void;
  editApiKey: (value: string) => void;
  editOauthMode: (mode: "official" | "custom") => void;
  editClientId: (value: string) => void;
  editClientSecret: (value: string) => void;
  setReplacingKey: (value: boolean) => void;
  markKeyStored: (provider: string) => void;
  revert: () => void;
  save: () => Promise<boolean>;
  persistAppearance: (patch: Partial<SharedConfig["ui"]>) => Promise<void>;
}

function failureText(caught: unknown, fallback: string): string {
  if (caught instanceof BrowserDaemonError) return caught.message;
  return fallback;
}

export function useSettingsDraft(): SettingsDraftApi {
  const { config, roles, client, replaceConfig, replaceRoles, setLanguage, t } = useDaemon();
  const toast = useToast();
  const [draft, setDraft] = useState<SharedConfig | null>(null);
  const [rolesDraft, setRolesDraft] = useState<Roles | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [oauthMode, setOauthMode] = useState<"official" | "custom">("official");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [oauthDirty, setOauthDirty] = useState(false);
  const [replacingKey, setReplacingKey] = useState(false);
  const [storedKeys, setStoredKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const touched = useRef(false);

  useEffect(() => {
    if (!config || !roles) return;
    if (!touched.current) {
      setDraft(structuredClone(config));
      setRolesDraft(structuredClone(roles));
      return;
    }
    setDraft((current) => (current ? { ...current, ui: { ...current.ui, ...config.ui } } : current));
  }, [config, roles]);

  const issues = draft && rolesDraft
    ? validateSettings({
        idleMinutes: draft.refine.idleMinutes,
        activeLimit: draft.topics.activeLimit,
        historyDays: draft.topics.historyDays,
        morningDigestTime: draft.reminders.morningDigestTime,
        weeklyReviewTime: draft.reminders.weeklyReviewTime,
        consolidateTime: rolesDraft.consolidation.time,
        timezone: rolesDraft.timezone,
        driveRoot: draft.drive.root,
        baseUrl: draft.llm.baseUrl,
        variants: draft.portrait.variants,
      })
    : [];

  const dirty = Boolean(
    draft && rolesDraft && config && roles &&
      isSettingsDirty({
        config: draft,
        savedConfig: config,
        roles: rolesDraft,
        savedRoles: roles,
        apiKey,
        oauthDirty,
      }),
  );

  const touch = (): void => {
    touched.current = true;
    setError(null);
  };

  const editDraft = useCallback((next: SharedConfig) => {
    touch();
    setDraft(next);
  }, []);

  const editRoles = useCallback((next: Roles) => {
    touch();
    setRolesDraft(next);
  }, []);

  const editApiKey = useCallback((value: string) => {
    touch();
    setApiKey(value);
  }, []);

  const editOauthMode = useCallback((mode: "official" | "custom") => {
    touch();
    setOauthMode(mode);
    setOauthDirty(true);
  }, []);

  const editClientId = useCallback((value: string) => {
    touch();
    setClientId(value);
    setOauthDirty(true);
  }, []);

  const editClientSecret = useCallback((value: string) => {
    touch();
    setClientSecret(value);
    setOauthDirty(true);
  }, []);

  const markKeyStored = useCallback((provider: string) => {
    setStoredKeys((current) => {
      const next = new Set(current);
      next.add(provider);
      return next;
    });
    setReplacingKey(false);
  }, []);

  const revert = useCallback(() => {
    if (config) setDraft(structuredClone(config));
    if (roles) setRolesDraft(structuredClone(roles));
    setApiKey("");
    setOauthMode("official");
    setClientId("");
    setClientSecret("");
    setOauthDirty(false);
    setReplacingKey(false);
    setError(null);
    touched.current = false;
  }, [config, roles]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft || !rolesDraft || !config || busy) return false;
    if (issues.length > 0) {
      setError(t("fieldError"));
      return false;
    }
    const secret = apiKey;
    const oauth: OauthPayload | null = oauthPayload({
      dirty: oauthDirty,
      mode: oauthMode,
      clientId,
      clientSecret,
    });
    setBusy(true);
    setError(null);
    try {
      const savedConfig = await client.updateConfig(configSaveBody(config, draft));
      const savedRoles = await client.updateRoles(rolesDraft);
      replaceConfig(savedConfig);
      replaceRoles(savedRoles);
      setDraft(structuredClone(savedConfig));
      setRolesDraft(structuredClone(savedRoles));
      const llmKey = llmKeyPayload(savedConfig.llm.provider, secret);
      if (llmKey) {
        await client.putLlmKey(llmKey.provider, llmKey.apiKey);
        setApiKey("");
        setReplacingKey(false);
        setStoredKeys((current) => {
          const next = new Set(current);
          next.add(llmKey.provider);
          return next;
        });
      }
      if (oauth) {
        await client.putOauth(oauth);
        setClientSecret("");
        setOauthDirty(false);
      }
      touched.current = false;
      toast.push({ message: t("settingsSaved"), tone: "success" });
      return true;
    } catch (caught) {
      setError(failureText(caught, t("actionFailed")));
      return false;
    } finally {
      setBusy(false);
    }
  }, [
    apiKey,
    busy,
    client,
    config,
    clientId,
    clientSecret,
    draft,
    issues.length,
    oauthDirty,
    oauthMode,
    replaceConfig,
    replaceRoles,
    rolesDraft,
    t,
    toast,
  ]);

  const persistAppearance = useCallback(
    async (patch: Partial<SharedConfig["ui"]>) => {
      if (!config) return;
      const previous = config;
      const next = appearanceConfig(config, patch);
      if (patch.language) setLanguage(patch.language);
      replaceConfig(next);
      setDraft((current) => (current ? { ...current, ui: next.ui } : current));
      try {
        const saved = await client.updateConfig(next);
        replaceConfig(saved);
        setDraft((current) => (current ? { ...current, ui: saved.ui } : current));
      } catch (caught) {
        if (patch.language) setLanguage(previous.ui.language);
        replaceConfig(previous);
        setDraft((current) => (current ? { ...current, ui: previous.ui } : current));
        toast.push({ message: failureText(caught, t("actionFailed")), tone: "danger" });
      }
    },
    [client, config, replaceConfig, setLanguage, t, toast],
  );

  return {
    draft,
    rolesDraft,
    issues,
    apiKey,
    oauthMode,
    clientId,
    clientSecret,
    replacingKey,
    storedKeys,
    busy,
    error,
    dirty,
    editDraft,
    editRoles,
    editApiKey,
    editOauthMode,
    editClientId,
    editClientSecret,
    setReplacingKey,
    markKeyStored,
    revert,
    save,
    persistAppearance,
  };
}
