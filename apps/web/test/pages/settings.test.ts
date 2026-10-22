import { describe, expect, test } from "bun:test";
import { createDefaultRoles, createDefaultSharedConfig, LLM_PROVIDERS, type Roles, type SharedConfig } from "@you-brain/protocol";

import {
  appearanceConfig,
  buildSavePlan,
  cliCommand,
  cliProbe,
  deepEqual,
  isSettingsDirty,
  llmKeyPayload,
  oauthPayload,
  providerOptions,
  sectionFromHref,
  shortcutGlyph,
  shortcutParts,
  shouldConfirmLeave,
  showStoredKey,
  testResultFresh,
  toggleMember,
  TEST_RESULT_MS,
} from "../../src/pages/settings/logic.js";

function dirtyInput(patch?: {
  config?: SharedConfig;
  roles?: Roles;
  apiKey?: string;
  oauthDirty?: boolean;
}) {
  const savedConfig = createDefaultSharedConfig();
  const savedRoles = createDefaultRoles();
  return {
    config: patch?.config ?? savedConfig,
    savedConfig,
    roles: patch?.roles ?? savedRoles,
    savedRoles,
    apiKey: patch?.apiKey ?? "",
    oauthDirty: patch?.oauthDirty ?? false,
  };
}

/** The submit body the previous settings page built, kept here as the contract. */
function legacyPlan(input: {
  config: SharedConfig;
  roles: Roles;
  apiKey: string;
  oauthMode: "official" | "custom";
  clientId: string;
  clientSecret: string;
  oauthDirty: boolean;
  savedProvider: string;
}) {
  const secret = input.apiKey.trim();
  const oauth = input.oauthDirty
    ? {
        mode: input.oauthMode,
        clientId: input.clientId.trim(),
        ...(input.clientSecret.trim() ? { clientSecret: input.clientSecret.trim() } : {}),
      }
    : null;
  const llmKey = secret !== "" && !input.savedProvider.endsWith("-cli")
    ? { provider: input.savedProvider, apiKey: secret }
    : null;
  return { config: input.config, roles: input.roles, llmKey, oauth };
}

describe("settings draft", () => {
  test("a clone is clean, and whitespace secrets do not count", () => {
    const saved = createDefaultSharedConfig();
    expect(isSettingsDirty(dirtyInput({ config: structuredClone(saved) }))).toBe(false);
    expect(isSettingsDirty(dirtyInput({ apiKey: "   " }))).toBe(false);
  });

  test("config, roles, a typed key, or a touched oauth form each make the draft dirty", () => {
    const saved = createDefaultSharedConfig();
    const changed = { ...saved, llm: { ...saved.llm, model: "deepseek-flash" } };
    expect(isSettingsDirty(dirtyInput({ config: changed }))).toBe(true);
    const roles = createDefaultRoles();
    expect(isSettingsDirty(dirtyInput({ roles: { ...roles, timezone: "UTC" } }))).toBe(true);
    expect(isSettingsDirty(dirtyInput({ apiKey: "sk-test" }))).toBe(true);
    expect(isSettingsDirty(dirtyInput({ oauthDirty: true }))).toBe(true);
  });

  test("deepEqual ignores key order and notices nested edits", () => {
    expect(deepEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, 2], [1])).toBe(false);
  });
});

describe("settings save payload", () => {
  test("matches the previous page for config, roles, key, and oauth", () => {
    const saved = createDefaultSharedConfig();
    const config: SharedConfig = {
      ...saved,
      llm: { ...saved.llm, provider: "deepseek", model: "deepseek-flash", baseUrl: "" },
      ui: { language: "en", shortcut: "CmdOrCtrl+Shift+Y" },
      drive: { root: "brain-hub" },
    };
    const roles = { ...createDefaultRoles(), timezone: "Asia/Shanghai" };
    const cases = [
      { apiKey: "  sk-test  ", oauthMode: "custom" as const, clientId: " id ", clientSecret: " sec ", oauthDirty: true },
      { apiKey: "", oauthMode: "official" as const, clientId: "", clientSecret: "", oauthDirty: false },
      { apiKey: "sk-test", oauthMode: "custom" as const, clientId: "id", clientSecret: "   ", oauthDirty: true },
      { apiKey: "sk-test", oauthMode: "official" as const, clientId: "id", clientSecret: "sec", oauthDirty: false },
    ];
    for (const item of cases) {
      const input = { config, roles, ...item, savedProvider: config.llm.provider };
      expect(buildSavePlan(input)).toEqual(legacyPlan(input));
    }
  });

  test("keeps every other config field when only the model changes", () => {
    const saved = createDefaultSharedConfig();
    const config: SharedConfig = { ...saved, llm: { ...saved.llm, model: "deepseek-flash" } };
    const plan = buildSavePlan({
      config,
      roles: createDefaultRoles(),
      apiKey: "",
      oauthMode: "official",
      clientId: "",
      clientSecret: "",
      oauthDirty: false,
    });
    expect(plan.config).toEqual(config);
    expect(plan.config.capture).toEqual(saved.capture);
    expect(plan.config.portrait).toEqual(saved.portrait);
    expect(plan.config.integrations).toEqual(saved.integrations);
    expect(plan.config.reminders).toEqual(saved.reminders);
    expect(plan.config.ui).toEqual(saved.ui);
    expect(plan.llmKey).toBeNull();
    expect(plan.oauth).toBeNull();
  });

  test("never puts a key or client secret into config or roles", () => {
    const config = createDefaultSharedConfig();
    const roles = createDefaultRoles();
    const plan = buildSavePlan({
      config,
      roles,
      apiKey: "sk-live-secret",
      oauthMode: "custom",
      clientId: "client-id",
      clientSecret: "client-secret-value",
      oauthDirty: true,
    });
    const stored = JSON.stringify({ config: plan.config, roles: plan.roles });
    expect(stored).not.toContain("sk-live-secret");
    expect(stored).not.toContain("client-secret-value");
    expect(plan.llmKey).toEqual({ provider: "deepseek", apiKey: "sk-live-secret" });
    expect(plan.oauth).toEqual({ mode: "custom", clientId: "client-id", clientSecret: "client-secret-value" });
  });

  test("uses the provider the server confirmed, and skips keys for a local CLI", () => {
    expect(llmKeyPayload("grok-cli", "sk-test")).toBeNull();
    expect(llmKeyPayload("ollama", "sk-test")).toEqual({ provider: "ollama", apiKey: "sk-test" });
    expect(llmKeyPayload("deepseek", "  ")).toBeNull();
    const plan = buildSavePlan({
      config: { ...createDefaultSharedConfig(), llm: { ...createDefaultSharedConfig().llm, provider: "grok-cli" } },
      roles: createDefaultRoles(),
      apiKey: "sk-test",
      oauthMode: "official",
      clientId: "",
      clientSecret: "",
      oauthDirty: false,
      savedProvider: "claude-cli",
    });
    expect(plan.llmKey).toBeNull();
  });

  test("omits an empty client secret but still posts the mode and client id", () => {
    expect(oauthPayload({ dirty: false, mode: "custom", clientId: "id", clientSecret: "sec" })).toBeNull();
    expect(oauthPayload({ dirty: true, mode: "custom", clientId: " id ", clientSecret: "  " })).toEqual({
      mode: "custom",
      clientId: "id",
    });
  });

  test("appearance patch writes ui onto the saved config and leaves the draft alone", () => {
    const saved = createDefaultSharedConfig();
    const patched = appearanceConfig(saved, { language: "en" });
    expect(patched.ui).toEqual({ language: "en", shortcut: saved.ui.shortcut });
    expect(patched.llm).toEqual(saved.llm);
    expect(patched.drive).toEqual(saved.drive);
    expect(saved.ui.language).toBe("zh");
  });
});

describe("settings sections", () => {
  test("reads a section from the settings route and ignores other pages", () => {
    expect(sectionFromHref("/settings?section=model")).toBe("model");
    expect(sectionFromHref("/settings?section=appearance")).toBe("appearance");
    expect(sectionFromHref("/settings?section=nope")).toBe("account");
    expect(sectionFromHref("/settings")).toBe("account");
    expect(sectionFromHref("/settings/")).toBe("account");
    expect(sectionFromHref("/today")).toBeNull();
    expect(sectionFromHref("/topics?section=model")).toBeNull();
  });

  test("asks to discard only when a dirty draft would leave its section", () => {
    expect(shouldConfirmLeave(true, "/settings?section=account", "/settings?section=model")).toBe(true);
    expect(shouldConfirmLeave(true, "/settings?section=capture", "/today")).toBe(true);
    expect(shouldConfirmLeave(true, "/settings", "/status")).toBe(true);
    expect(shouldConfirmLeave(true, "/settings?section=account", "/settings?section=account&theme=dark")).toBe(false);
    expect(shouldConfirmLeave(true, "/settings?section=nope", "/settings?section=account")).toBe(false);
    expect(shouldConfirmLeave(false, "/settings?section=account", "/settings?section=model")).toBe(false);
    expect(shouldConfirmLeave(false, "/settings?section=account", "/today")).toBe(false);
    expect(shouldConfirmLeave(true, "/today", "/status")).toBe(false);
  });
});

describe("provider groups and key display", () => {
  test("splits providers into local subscriptions and API, without dropping any", () => {
    const options = providerOptions(LLM_PROVIDERS);
    const local = options.filter((option) => option.group === "local").map((option) => option.value);
    const api = options.filter((option) => option.group === "api").map((option) => option.value);
    expect(local.every((provider) => provider.endsWith("-cli"))).toBe(true);
    expect(api.some((provider) => provider.endsWith("-cli"))).toBe(false);
    expect(new Set([...local, ...api])).toEqual(new Set(LLM_PROVIDERS));
    expect(options.findIndex((option) => option.group === "api")).toBeGreaterThan(
      options.findIndex((option) => option.group === "local"),
    );
    expect(cliCommand("grok-cli")).toBe("grok");
    expect(cliCommand("claude-cli")).toBe("claude");
  });

  test("maps daemon warnings onto a probe only for the saved CLI", () => {
    expect(cliProbe("deepseek", "deepseek", [])).toBeNull();
    expect(cliProbe("grok-cli", "deepseek", [])).toBe("later");
    expect(cliProbe("grok-cli", "grok-cli", [])).toBe("installed");
    expect(cliProbe("grok-cli", "grok-cli", [{ code: "LLM_NOT_CONFIGURED" }])).toBe("installed");
    expect(cliProbe("grok-cli", "grok-cli", [{ code: "LLM_CLI_MISSING" }])).toBe("missing");
    expect(cliProbe("claude-cli", "claude-cli", [{ code: "LLM_CLI_UNAUTHENTICATED" }])).toBe("login");
    expect(cliProbe("codex-cli", "codex-cli", [{ code: "LLM_CLI_UNRESPONSIVE" }])).toBe("unresponsive");
  });

  test("shows the saved chip only when nothing is typed and the user is not replacing it", () => {
    expect(showStoredKey(true, false, "")).toBe(true);
    expect(showStoredKey(true, false, "   ")).toBe(true);
    expect(showStoredKey(true, true, "")).toBe(false);
    expect(showStoredKey(true, false, "sk-new")).toBe(false);
    expect(showStoredKey(false, false, "")).toBe(false);
  });

  test("keeps a connection result for ten seconds", () => {
    expect(testResultFresh(1_000, 1_000)).toBe(true);
    expect(testResultFresh(1_000, 1_000 + TEST_RESULT_MS - 1)).toBe(true);
    expect(testResultFresh(1_000, 1_000 + TEST_RESULT_MS)).toBe(false);
    expect(testResultFresh(1_000, 999)).toBe(false);
  });

  test("toggles an integration member without duplicating it", () => {
    expect(toggleMember(["claude-code"], "codex", true)).toEqual(["claude-code", "codex"]);
    expect(toggleMember(["claude-code", "codex"], "codex", true)).toEqual(["claude-code", "codex"]);
    expect(toggleMember(["claude-code", "codex"], "codex", false)).toEqual(["claude-code"]);
  });

  test("splits a shortcut into glyphs", () => {
    expect(shortcutParts(" CmdOrCtrl+Shift+Y ")).toEqual(["CmdOrCtrl", "Shift", "Y"]);
    expect(shortcutParts("")).toEqual([]);
    expect(shortcutGlyph("CmdOrCtrl", "⌘")).toBe("⌘");
    expect(shortcutGlyph("CmdOrCtrl", "Ctrl")).toBe("Ctrl");
    expect(shortcutGlyph("Shift", "⌘")).toBe("⇧");
    expect(shortcutGlyph("y", "⌘")).toBe("Y");
  });
});
