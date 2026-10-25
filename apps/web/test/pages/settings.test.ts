import { describe, expect, test } from "bun:test";
import { createDefaultRoles, createDefaultSharedConfig, LLM_PROVIDERS, type Roles, type SharedConfig } from "@you-brain/protocol";

import {
  appearanceConfig,
  buildSavePlan,
  configSaveBody,
  searchSemantic,
  cliCommand,
  cliProbe,
  deepEqual,
  isSettingsDirty,
  llmKeyPayload,
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
}) {
  const savedConfig = createDefaultSharedConfig();
  const savedRoles = createDefaultRoles();
  return {
    config: patch?.config ?? savedConfig,
    savedConfig,
    roles: patch?.roles ?? savedRoles,
    savedRoles,
    apiKey: patch?.apiKey ?? "",
  };
}

/** The submit body the previous settings page built, kept here as the contract. */
function legacyPlan(input: {
  config: SharedConfig;
  roles: Roles;
  apiKey: string;
  savedProvider: string;
}) {
  const secret = input.apiKey.trim();
  const llmKey = secret !== "" && !input.savedProvider.endsWith("-cli")
    ? { provider: input.savedProvider, apiKey: secret }
    : null;
  return { config: input.config, roles: input.roles, llmKey };
}

describe("settings draft", () => {
  test("a clone is clean, and whitespace secrets do not count", () => {
    const saved = createDefaultSharedConfig();
    expect(isSettingsDirty(dirtyInput({ config: structuredClone(saved) }))).toBe(false);
    expect(isSettingsDirty(dirtyInput({ apiKey: "   " }))).toBe(false);
  });

  test("config, roles, or a typed key each make the draft dirty", () => {
    const saved = createDefaultSharedConfig();
    const changed = { ...saved, llm: { ...saved.llm, model: "deepseek-flash" } };
    expect(isSettingsDirty(dirtyInput({ config: changed }))).toBe(true);
    const roles = createDefaultRoles();
    expect(isSettingsDirty(dirtyInput({ roles: { ...roles, timezone: "UTC" } }))).toBe(true);
    expect(isSettingsDirty(dirtyInput({ apiKey: "sk-test" }))).toBe(true);
  });

  test("deepEqual ignores key order and notices nested edits", () => {
    expect(deepEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, 2], [1])).toBe(false);
  });
});

describe("settings save payload", () => {
  test("matches the previous page for config, roles, and key", () => {
    const saved = createDefaultSharedConfig();
    const config: SharedConfig = {
      ...saved,
      llm: { ...saved.llm, provider: "deepseek", model: "deepseek-flash", baseUrl: "" },
      ui: { language: "en", shortcut: "CmdOrCtrl+Shift+Y" },
      drive: { root: "brain-hub" },
    };
    const roles = { ...createDefaultRoles(), timezone: "Asia/Shanghai" };
    const cases = [
      { apiKey: "  sk-test  " },
      { apiKey: "" },
      { apiKey: "   " },
      { apiKey: "sk-test" },
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
    });
    expect(plan.config).toEqual(config);
    expect(plan.config.capture).toEqual(saved.capture);
    expect(plan.config.portrait).toEqual(saved.portrait);
    expect(plan.config.integrations).toEqual(saved.integrations);
    expect(plan.config.reminders).toEqual(saved.reminders);
    expect(plan.config.ui).toEqual(saved.ui);
    expect(plan.llmKey).toBeNull();
  });

  test("never puts a key into config or roles", () => {
    const config = createDefaultSharedConfig();
    const roles = createDefaultRoles();
    const plan = buildSavePlan({
      config,
      roles,
      apiKey: "sk-live-secret",
    });
    const stored = JSON.stringify({ config: plan.config, roles: plan.roles });
    expect(stored).not.toContain("sk-live-secret");
    expect(plan.llmKey).toEqual({ provider: "deepseek", apiKey: "sk-live-secret" });
  });

  test("uses the provider the server confirmed, and skips keys for a local CLI", () => {
    expect(llmKeyPayload("grok-cli", "sk-test")).toBeNull();
    expect(llmKeyPayload("ollama", "sk-test")).toEqual({ provider: "ollama", apiKey: "sk-test" });
    expect(llmKeyPayload("deepseek", "  ")).toBeNull();
    const plan = buildSavePlan({
      config: { ...createDefaultSharedConfig(), llm: { ...createDefaultSharedConfig().llm, provider: "grok-cli" } },
      roles: createDefaultRoles(),
      apiKey: "sk-test",
      savedProvider: "claude-cli",
    });
    expect(plan.llmKey).toBeNull();
  });

  test("semantic search defaults to on and is omitted from the save body until it changes", () => {
    const saved = createDefaultSharedConfig();
    expect(saved.search.semantic).toBe(true);
    expect(searchSemantic(saved)).toBe(true);
    expect(searchSemantic({})).toBe(true);
    expect(searchSemantic(null)).toBe(true);
    const same = configSaveBody(saved, structuredClone(saved));
    expect(same).not.toHaveProperty("search");
    expect(same.llm).toEqual(saved.llm);
    expect(same.refine).toEqual(saved.refine);
    expect(same.capture).toEqual(saved.capture);
    const off = configSaveBody(saved, { ...saved, search: { semantic: false } });
    expect(off.search).toEqual({ semantic: false });
    expect(off.llm).toEqual(saved.llm);
    expect(off.topics).toEqual(saved.topics);
    const back = configSaveBody({ ...saved, search: { semantic: false } }, saved);
    expect(back.search).toEqual({ semantic: true });
    const modelOnly = configSaveBody(saved, { ...saved, llm: { ...saved.llm, model: "deepseek-flash" } });
    expect(modelOnly).not.toHaveProperty("search");
    expect(modelOnly.llm.model).toBe("deepseek-flash");
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
