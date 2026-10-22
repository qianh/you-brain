import type { Roles, SharedConfig } from "@you-brain/protocol";

import { parseAppLocation, type SettingsSection } from "../../lib/route.js";

/** Local subscription providers talk to a CLI the user already logged in to. */
export function isCliProvider(provider: string): boolean {
  return provider.endsWith("-cli");
}

const CLI_COMMANDS: Record<string, string> = {
  "grok-cli": "grok",
  "claude-cli": "claude",
  "codex-cli": "codex",
  "gemini-cli": "gemini",
  "opencode-cli": "opencode",
};

export function cliCommand(provider: string): string {
  return CLI_COMMANDS[provider] ?? provider.replace(/-cli$/u, "");
}

export type ProviderGroup = "local" | "api";

export interface ProviderOption {
  value: string;
  group: ProviderGroup;
}

/** Local subscriptions first, then API providers. Order inside a group is preserved. */
export function providerOptions(providers: readonly string[]): ProviderOption[] {
  const local: ProviderOption[] = [];
  const api: ProviderOption[] = [];
  for (const value of providers) {
    if (isCliProvider(value)) local.push({ value, group: "local" });
    else api.push({ value, group: "api" });
  }
  return [...local, ...api];
}

export type CliProbe = "installed" | "missing" | "login" | "unresponsive" | "later";

/**
 * Detection describes the provider the daemon is actually using.
 * A draft selection that has not been saved yet is "later".
 * API providers have no CLI probe.
 */
export function cliProbe(
  provider: string,
  savedProvider: string,
  warnings: readonly { code: string }[],
): CliProbe | null {
  if (!isCliProvider(provider)) return null;
  if (provider !== savedProvider) return "later";
  const codes = new Set(warnings.map((warning) => warning.code));
  if (codes.has("LLM_CLI_MISSING")) return "missing";
  if (codes.has("LLM_CLI_UNAUTHENTICATED")) return "login";
  if (codes.has("LLM_CLI_UNRESPONSIVE")) return "unresponsive";
  return "installed";
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => deepEqual(a[key], b[key]));
}

export function isSettingsDirty(input: {
  config: SharedConfig;
  savedConfig: SharedConfig;
  roles: Roles;
  savedRoles: Roles;
  apiKey: string;
  oauthDirty: boolean;
}): boolean {
  if (input.apiKey.trim() !== "") return true;
  if (input.oauthDirty) return true;
  if (!deepEqual(input.config, input.savedConfig)) return true;
  return !deepEqual(input.roles, input.savedRoles);
}

export interface OauthPayload {
  mode: "official" | "custom";
  clientId: string;
  clientSecret?: string;
}

export interface LlmKeyPayload {
  provider: string;
  apiKey: string;
}

/** Same shape the previous page posted. Secrets stay out of config and roles. */
export function oauthPayload(input: {
  dirty: boolean;
  mode: "official" | "custom";
  clientId: string;
  clientSecret: string;
}): OauthPayload | null {
  if (!input.dirty) return null;
  const secret = input.clientSecret.trim();
  const body: OauthPayload = { mode: input.mode, clientId: input.clientId.trim() };
  if (secret !== "") body.clientSecret = secret;
  return body;
}

export function llmKeyPayload(provider: string, apiKey: string): LlmKeyPayload | null {
  const secret = apiKey.trim();
  if (secret === "" || isCliProvider(provider)) return null;
  return { provider, apiKey: secret };
}

export interface SavePlan {
  config: SharedConfig;
  roles: Roles;
  llmKey: LlmKeyPayload | null;
  oauth: OauthPayload | null;
}

export function buildSavePlan(input: {
  config: SharedConfig;
  roles: Roles;
  apiKey: string;
  oauthMode: "official" | "custom";
  clientId: string;
  clientSecret: string;
  oauthDirty: boolean;
  savedProvider?: string;
}): SavePlan {
  const provider = input.savedProvider ?? input.config.llm.provider;
  return {
    config: input.config,
    roles: input.roles,
    llmKey: llmKeyPayload(provider, input.apiKey),
    oauth: oauthPayload({
      dirty: input.oauthDirty,
      mode: input.oauthMode,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    }),
  };
}

/** Missing means the protocol default: semantic search stays on. */
export function searchSemantic(config: { search?: { semantic?: boolean } } | null | undefined): boolean {
  return config?.search?.semantic !== false;
}

export type ConfigSaveBody = Omit<SharedConfig, "search"> & { search?: SharedConfig["search"] };

/**
 * The save body keeps every other field. `search` is included only when the
 * semantic switch actually changed, as `{ search: { semantic } }`.
 */
export function configSaveBody(saved: SharedConfig, draft: SharedConfig): ConfigSaveBody {
  if (searchSemantic(saved) === searchSemantic(draft)) {
    const { search: _search, ...rest } = draft;
    return rest;
  }
  return { ...draft, search: { semantic: searchSemantic(draft) } };
}

/** Appearance writes only `ui` onto the last saved config, never the dirty draft. */
export function appearanceConfig(
  saved: SharedConfig,
  patch: Partial<SharedConfig["ui"]>,
): SharedConfig {
  return { ...saved, ui: { ...saved.ui, ...patch } };
}

export function sectionFromHref(href: string): SettingsSection | null {
  const location = parseAppLocation(href);
  if (location.pathname !== "/settings") return null;
  return location.section;
}

/** Dirty settings ask before the section or the page changes. Same section is fine. */
export function shouldConfirmLeave(dirty: boolean, fromHref: string, toHref: string): boolean {
  if (!dirty) return false;
  const from = parseAppLocation(fromHref);
  if (from.pathname !== "/settings") return false;
  const to = parseAppLocation(toHref);
  if (to.pathname !== "/settings") return true;
  return from.section !== to.section;
}

export const TEST_RESULT_MS = 10_000;

export function testResultFresh(shownAt: number, now: number, ttl = TEST_RESULT_MS): boolean {
  return now >= shownAt && now - shownAt < ttl;
}

/** Saved keys render as a chip. A typed value stays in the field and is never replaced by a stored secret. */
export function showStoredKey(stored: boolean, replacing: boolean, typed: string): boolean {
  return stored && !replacing && typed.trim() === "";
}

export function numberOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function toggleMember(selected: readonly string[], source: string, on: boolean): string[] {
  if (on) return selected.includes(source) ? [...selected] : [...selected, source];
  return selected.filter((item) => item !== source);
}

export function isTimeOfDay(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

export function shortcutParts(shortcut: string): string[] {
  return shortcut
    .trim()
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

export function shortcutGlyph(part: string, mod: "⌘" | "Ctrl"): string {
  if (part === "CmdOrCtrl" || part === "Mod" || part === "Cmd" || part === "Meta" || part === "Command") return mod;
  if (part === "Control") return "Ctrl";
  if (part === "Shift") return "⇧";
  if (part === "Alt" || part === "Option") return "⌥";
  if (part === "Enter" || part === "Return") return "↵";
  return part.length === 1 ? part.toUpperCase() : part;
}
