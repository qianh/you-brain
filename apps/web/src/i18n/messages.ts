import type { Language } from "../lib/format.js";
import { en as commonEn, zh as commonZh } from "./common.js";
import { en as todayEn, zh as todayZh } from "./pages/today.js";
import { en as panelEn, zh as panelZh } from "./pages/panel.js";
import { en as topicsEn, zh as topicsZh } from "./pages/topics.js";
import { en as searchEn, zh as searchZh } from "./pages/search.js";
import { en as portraitEn, zh as portraitZh } from "./pages/portrait.js";
import { en as devicesEn, zh as devicesZh } from "./pages/devices.js";
import { en as statusEn, zh as statusZh } from "./pages/status.js";
import { en as knowledgeEn, zh as knowledgeZh } from "./pages/knowledge.js";
import { en as settingsEn, zh as settingsZh } from "./pages/settings.js";

export const messageCatalogs = [
  { name: "common", zh: commonZh, en: commonEn },
  { name: "today", zh: todayZh, en: todayEn },
  { name: "panel", zh: panelZh, en: panelEn },
  { name: "topics", zh: topicsZh, en: topicsEn },
  { name: "search", zh: searchZh, en: searchEn },
  { name: "portrait", zh: portraitZh, en: portraitEn },
  { name: "devices", zh: devicesZh, en: devicesEn },
  { name: "status", zh: statusZh, en: statusEn },
  { name: "knowledge", zh: knowledgeZh, en: knowledgeEn },
  { name: "settings", zh: settingsZh, en: settingsEn },
] as const;

export const zh = { ...commonZh, ...todayZh, ...panelZh, ...topicsZh, ...searchZh, ...portraitZh, ...devicesZh, ...statusZh, ...knowledgeZh, ...settingsZh } as const;
export const en: { [K in keyof typeof zh]: string } = { ...commonEn, ...todayEn, ...panelEn, ...topicsEn, ...searchEn, ...portraitEn, ...devicesEn, ...statusEn, ...knowledgeEn, ...settingsEn };

export type MessageKey = keyof typeof zh;

export function duplicateMessageKeys(
  catalogs: readonly { name: string; zh: object; en: object }[],
): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const catalog of catalogs) {
    for (const key of Object.keys(catalog.zh)) {
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
  }
  return duplicates;
}

export function translate(
  language: Language,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const template = (language === "en" ? en : zh)[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

export function topicStatusKey(status: string): MessageKey {
  if (status === "follow_up") return "statusFollowUp";
  if (status === "done") return "statusDone";
  if (status === "parked") return "statusParked";
  return "statusActive";
}

export function todoStatusKey(status: string): MessageKey {
  if (status === "done") return "todoDone";
  if (status === "dropped") return "todoDropped";
  return "todoOpen";
}
