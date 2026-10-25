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
} from "./logic.js";

export interface SettingsDraftApi {
  draft: SharedConfig | null;
  rolesDraft: Roles | null;
  issues: MessageKey[];
  apiKey: string;
  replacingKey: boolean;
  storedKeys: ReadonlySet<string>;
  busy: boolean;
  error: string | null;
  dirty: boolean;
  editDraft: (next: SharedConfig) => void;
  editRoles: (next: Roles) => void;
  editApiKey: (value: string) => void;
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
    draft,
    issues.length,
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
    replacingKey,
    storedKeys,
    busy,
    error,
    dirty,
    editDraft,
    editRoles,
    editApiKey,
    setReplacingKey,
    markKeyStored,
    revert,
    save,
    persistAppearance,
  };
}
