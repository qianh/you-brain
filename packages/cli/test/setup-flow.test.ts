import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { platformPaths, type YouBrainPaths } from "@you-brain/core";
import { MISSING_OFFICIAL_OAUTH_MESSAGE } from "@you-brain/core/auth";
import { MemoryDrive } from "@you-brain/core/drive";
import type { BrainHubMigrationPlan } from "@you-brain/core/migrate";

import { runSetup, type SetupFlags, type SetupHooks } from "../src/setup.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PLAN: BrainHubMigrationPlan = {
  detected: true,
  defaults: { driveRoot: "InheritedRoot", displayName: "HubDevice" },
  items: [
    {
      id: "schedule:upload",
      kind: "schedule",
      description: "停用 BrainHub 上传定时任务",
      paths: ["/tmp/you-brain-setup-test/com.brainhub.upload.plist"],
      preview: "备份并移除",
    },
  ],
  warnings: [],
};

function flags(extra: Partial<SetupFlags> = {}): SetupFlags {
  return {
    yes: true,
    inheritBrainhub: false,
    skipBrainhub: false,
    sources: [],
    integrations: "",
    backfill: false,
    ...extra,
  };
}

async function layout(): Promise<{ homeDir: string; paths: YouBrainPaths; env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(join(tmpdir(), "you-brain-setup-flow-"));
  roots.push(root);
  const homeDir = join(root, "home");
  const env: NodeJS.ProcessEnv = {
    YOU_BRAIN_DATA_DIR: join(root, "data"),
    YOU_BRAIN_HOME: join(root, "out"),
  };
  const paths = platformPaths({ platform: "darwin", homeDir, env });
  return { homeDir, paths, env };
}

function harness(
  base: { homeDir: string; paths: YouBrainPaths; env: NodeJS.ProcessEnv },
  hooks: SetupHooks = {},
): {
  hooks: SetupHooks;
  logs: string[];
  events: string[];
} {
  const logs: string[] = [];
  const events: string[] = [];
  return {
    logs,
    events,
    hooks: {
      log: (message) => logs.push(message),
      isTTY: false,
      env: base.env,
      homeDir: base.homeDir,
      paths: base.paths,
      platform: "darwin",
      planBrainHubMigration: async () => PLAN,
      applyBrainHubMigration: async (options) => {
        events.push("takeover");
        return { backupDir: options.backupDir, removed: [...options.selectedIds] };
      },
      openGoogleDrive: async (options) => {
        events.push("login");
        return {
          drive: new MemoryDrive(),
          config: {
            ...options.local,
            driveRootId: "folder-123",
            account: {
              email: "owner@example.com",
              displayName: "Owner",
              permissionId: "perm-1",
            },
          },
        };
      },
      ...hooks,
    },
  };
}

describe("setup BrainHub and official OAuth", () => {
  it("asks about BrainHub before login and disables it only after login succeeds", async () => {
    const base = await layout();
    const { hooks, logs, events } = harness(base, { hasOfficialOAuth: () => true });
    await runSetup(flags({ inheritBrainhub: true }), hooks);
    expect(events).toEqual(["login", "takeover"]);
    const deferAt = logs.findIndex((line) => line.includes("将在 Google 登录成功后接管"));
    const loginAt = logs.findIndex((line) => line.includes("已登录 Google Drive（owner@example.com）"));
    const takeoverAt = logs.findIndex((line) => line.startsWith("已接管 BrainHub，备份在 "));
    expect(deferAt).toBeGreaterThanOrEqual(0);
    expect(loginAt).toBeGreaterThan(deferAt);
    expect(takeoverAt).toBeGreaterThan(loginAt);
    const progress = JSON.parse(await readFile(join(base.paths.dataDir, "setup.json"), "utf8")) as {
      brainhub: boolean;
      google: boolean;
    };
    expect(progress).toMatchObject({ brainhub: true, google: true });
  });

  it("does not disable BrainHub when Google login fails", async () => {
    const base = await layout();
    const { hooks, logs, events } = harness(base, {
      hasOfficialOAuth: () => true,
      openGoogleDrive: async () => {
        events.push("login");
        throw new Error("Google 登录已取消");
      },
    });
    await expect(runSetup(flags({ inheritBrainhub: true }), hooks)).rejects.toThrow("Google 登录已取消");
    expect(events).toEqual(["login"]);
    expect(logs.some((line) => line.includes("已接管 BrainHub"))).toBe(false);
    expect(existsSync(join(base.paths.dataDir, "setup.json"))).toBe(false);
  });

  it("does not take over again when setup is run a second time", async () => {
    const base = await layout();
    const { hooks, events } = harness(base, { hasOfficialOAuth: () => true });
    const setupFlags = flags({ inheritBrainhub: true });
    await runSetup(setupFlags, hooks);
    await runSetup(setupFlags, hooks);
    expect(events).toEqual(["login", "takeover"]);
  });

  it("does not take over or error when BrainHub was already taken over", async () => {
    const base = await layout();
    await mkdir(base.paths.dataDir, { recursive: true });
    await writeFile(
      join(base.paths.dataDir, "setup.json"),
      `${JSON.stringify({
        version: 1,
        google: false,
        drive: false,
        brainhub: true,
        model: false,
        sources: false,
        integrations: false,
        backfill: false,
      })}\n`,
    );
    const { hooks, logs, events } = harness(base, { hasOfficialOAuth: () => true });
    await runSetup(flags({ inheritBrainhub: true }), hooks);
    expect(events).toEqual(["login"]);
    expect(logs.some((line) => line.includes("接管 BrainHub"))).toBe(false);
    const progress = JSON.parse(await readFile(join(base.paths.dataDir, "setup.json"), "utf8")) as {
      brainhub: boolean;
    };
    expect(progress.brainhub).toBe(true);
  });

  it("returns to the login choice when this build has no official credentials", async () => {
    const base = await layout();
    const questions: string[] = [];
    let loginAsks = 0;
    const { hooks, logs, events } = harness(base, {
      isTTY: true,
      hasOfficialOAuth: () => false,
      planBrainHubMigration: async () => ({ detected: false, defaults: {}, items: [], warnings: [] }),
      ask: async (question) => {
        questions.push(question);
        if (question.includes("Google 登录方式")) {
          loginAsks += 1;
          return loginAsks === 1 ? "1" : "2";
        }
        if (question.includes("client id")) return "custom.apps.googleusercontent.com";
        if (question.includes("client secret")) throw new Error("stop-before-keychain");
        throw new Error(`unexpected question: ${question}`);
      },
    });
    await expect(runSetup(flags({ yes: false }), hooks)).rejects.toThrow("stop-before-keychain");
    expect(logs).toContain(MISSING_OFFICIAL_OAUTH_MESSAGE);
    expect(loginAsks).toBe(2);
    expect(events).toEqual([]);
    expect(questions.filter((question) => question.includes("Google 登录方式"))).toHaveLength(2);
  });

  it("accepts official login when YOU_BRAIN_GOOGLE_* is set for a source run", async () => {
    const base = await layout();
    const previousId = process.env.YOU_BRAIN_BUNDLED_OAUTH_CLIENT_ID;
    const previousSecret = process.env.YOU_BRAIN_BUNDLED_OAUTH_CLIENT_SECRET;
    delete process.env.YOU_BRAIN_BUNDLED_OAUTH_CLIENT_ID;
    delete process.env.YOU_BRAIN_BUNDLED_OAUTH_CLIENT_SECRET;
    const questions: string[] = [];
    try {
      const { hooks, logs, events } = harness(base, {
        isTTY: true,
        env: {
          ...base.env,
          YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID: "sample.apps.googleusercontent.com",
          YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET: "sample-secret",
        },
        planBrainHubMigration: async () => ({
          detected: false,
          defaults: {},
          items: [],
          warnings: [],
        }),
        ask: async (question) => {
          questions.push(question);
          if (question.includes("Google 登录方式")) return "1";
          throw new Error(`unexpected question: ${question}`);
        },
        openGoogleDrive: async () => {
          events.push("login");
          throw new Error("stop-after-official-accepted");
        },
      });
      await expect(runSetup(flags({ yes: false }), hooks)).rejects.toThrow(
        "stop-after-official-accepted",
      );
      expect(logs).not.toContain(MISSING_OFFICIAL_OAUTH_MESSAGE);
      expect(events).toEqual(["login"]);
      expect(questions).toEqual(["Google 登录方式：1 官方  2 自带凭据 [1]："]);
    } finally {
      if (previousId === undefined) delete process.env.YOU_BRAIN_BUNDLED_OAUTH_CLIENT_ID;
      else process.env.YOU_BRAIN_BUNDLED_OAUTH_CLIENT_ID = previousId;
      if (previousSecret === undefined) delete process.env.YOU_BRAIN_BUNDLED_OAUTH_CLIENT_SECRET;
      else process.env.YOU_BRAIN_BUNDLED_OAUTH_CLIENT_SECRET = previousSecret;
    }
  });

  it("rejects an explicit official mode when credentials are missing", async () => {
    const base = await layout();
    const { hooks, events } = harness(base, {
      hasOfficialOAuth: () => false,
      planBrainHubMigration: async () => ({ detected: false, defaults: {}, items: [], warnings: [] }),
    });
    await expect(runSetup(flags({ oauth: "official" }), hooks)).rejects.toThrow(
      MISSING_OFFICIAL_OAUTH_MESSAGE,
    );
    expect(events).toEqual([]);
  });
});

const CLIENT_DIRS = [".claude", ".codex", ".grok", ".cursor", ".gemini"] as const;

const INTEGRATION_FILES = [
  ".claude.json",
  ".claude/CLAUDE.md",
  ".claude/skills/you-brain/SKILL.md",
  ".claude/skills/you-brain-portrait/SKILL.md",
  ".codex/config.toml",
  ".codex/AGENTS.md",
  ".codex/skills/you-brain/SKILL.md",
  ".codex/skills/you-brain-portrait/SKILL.md",
  ".grok/config.toml",
  ".grok/AGENTS.md",
  ".grok/skills/you-brain/SKILL.md",
  ".grok/skills/you-brain-portrait/SKILL.md",
  ".cursor/mcp.json",
  ".cursor/skills/you-brain/SKILL.md",
  ".cursor/skills/you-brain-portrait/SKILL.md",
  ".gemini/settings.json",
  ".gemini/GEMINI.md",
  ".gemini/skills/you-brain/SKILL.md",
  ".gemini/skills/you-brain-portrait/SKILL.md",
] as const;

describe("setup integration confirmation", () => {
  it("accepts every client when the summary is confirmed with enter", async () => {
    const base = await integrationLayout();
    const { logs, questions } = await runIntegrations(base, { answers: [""] });
    expect(questions).toEqual(["接入全部？[Y/n/c] "]);
    expectSummary(logs);
    expect(logs).toContain("已接入 20 项，跳过 0 项");
    for (const file of INTEGRATION_FILES) expect(existsSync(join(base.homeDir, file))).toBe(true);
    const consent = JSON.parse(
      await readFile(join(base.paths.dataDir, "portrait-consent.json"), "utf8"),
    ) as { itemIds: string[] };
    expect(consent.itemIds).toContain("claude-code:portrait");
    expect(consent.itemIds).toContain("cursor:portrait");
    expect(consent.itemIds).toContain("gemini-cli:skill:you-brain");
  });

  it("writes nothing and records no consent when the answer is n", async () => {
    const base = await integrationLayout();
    const before = await filesUnder(base.homeDir);
    const { logs, questions } = await runIntegrations(base, { answers: ["n"] });
    expect(questions).toEqual(["接入全部？[Y/n/c] "]);
    expect(logs).toContain("已接入 0 项，跳过 0 项");
    expect(await filesUnder(base.homeDir)).toEqual(before);
    expect(existsSync(join(base.paths.dataDir, "portrait-consent.json"))).toBe(false);
    expect(existsSync(join(base.paths.dataDir, "managed-blocks.json"))).toBe(false);
  });

  it("confirms one client at a time after c, and skips the clients answered n", async () => {
    const base = await integrationLayout();
    const { logs, questions } = await runIntegrations(base, {
      answers: ["c", "y", "n", "y", "n", "y"],
    });
    expect(questions[0]).toBe("接入全部？[Y/n/c] ");
    expect(questions.slice(1)).toEqual([
      "接入 claude-code（4 项）？ [Y/n] ",
      "接入 codex（4 项）？ [Y/n] ",
      "接入 grok-build（4 项）？ [Y/n] ",
      "接入 cursor（4 项）？ [Y/n] ",
      "接入 gemini-cli（4 项）？ [Y/n] ",
    ]);
    expect(questions.some((question) => question.includes(":mcp") || question.includes(":skill"))).toBe(
      false,
    );
    expectSummary(logs);
    expect(existsSync(join(base.homeDir, ".claude/CLAUDE.md"))).toBe(true);
    expect(existsSync(join(base.homeDir, ".claude/skills/you-brain/SKILL.md"))).toBe(true);
    expect(existsSync(join(base.homeDir, ".grok/AGENTS.md"))).toBe(true);
    expect(existsSync(join(base.homeDir, ".gemini/GEMINI.md"))).toBe(true);
    expect(existsSync(join(base.homeDir, ".codex/AGENTS.md"))).toBe(false);
    expect(existsSync(join(base.homeDir, ".codex/config.toml"))).toBe(false);
    expect(existsSync(join(base.homeDir, ".codex/skills/you-brain/SKILL.md"))).toBe(false);
    expect(existsSync(join(base.homeDir, ".cursor/mcp.json"))).toBe(false);
    expect(existsSync(join(base.homeDir, ".cursor/skills/you-brain/SKILL.md"))).toBe(false);
    const consent = JSON.parse(
      await readFile(join(base.paths.dataDir, "portrait-consent.json"), "utf8"),
    ) as { itemIds: string[] };
    expect(consent.itemIds).toContain("claude-code:portrait");
    expect(consent.itemIds).toContain("grok-build:mcp");
    expect(consent.itemIds.some((id) => id.startsWith("codex:"))).toBe(false);
    expect(consent.itemIds.some((id) => id.startsWith("cursor:"))).toBe(false);
    expect(logs).toContain("已接入 12 项，跳过 0 项");
  });

  it("limits the summary to --integrations and still asks once", async () => {
    const base = await integrationLayout();
    const { logs, questions } = await runIntegrations(base, {
      integrations: "claude-code,codex",
      answers: [""],
    });
    expect(questions).toEqual(["接入全部？[Y/n/c] "]);
    const summary = logs.filter((line) => line.startsWith("  "));
    expect(summary.map((line) => line.trim().split(/\s+/)[0])).toEqual(["claude-code", "codex"]);
    expect(summary.join("\n")).toContain(".claude/CLAUDE.md");
    expect(summary.join("\n")).toContain(".codex/config.toml");
    expect(existsSync(join(base.homeDir, ".claude.json"))).toBe(true);
    expect(existsSync(join(base.homeDir, ".codex/AGENTS.md"))).toBe(true);
    expect(existsSync(join(base.homeDir, ".grok/config.toml"))).toBe(false);
    expect(logs).toContain("已接入 8 项，跳过 0 项");
  });

  it("skips every file when --no-integrations is set", async () => {
    const base = await integrationLayout();
    const before = await filesUnder(base.homeDir);
    const { logs, questions } = await runIntegrations(base, { skipIntegrations: true, tty: false });
    expect(questions).toEqual([]);
    expectSummary(logs);
    expect(logs).toContain("已接入 0 项，跳过 0 项");
    expect(await filesUnder(base.homeDir)).toEqual(before);
    expect(existsSync(join(base.paths.dataDir, "portrait-consent.json"))).toBe(false);
  });

  it("accepts every client with --yes and does not ask", async () => {
    const base = await integrationLayout();
    const { logs, questions } = await runIntegrations(base, { yes: true, tty: false });
    expect(questions).toEqual([]);
    expectSummary(logs);
    expect(logs).toContain("已接入 20 项，跳过 0 项");
    for (const file of INTEGRATION_FILES) expect(existsSync(join(base.homeDir, file))).toBe(true);

    const again = await runIntegrations(base, { yes: true, integrations: "claude-code", tty: false });
    const claude = again.logs.find((line) => line.startsWith("  claude-code"));
    expect(claude).toContain("已是最新");
    expect(claude).toContain(".claude/CLAUDE.md");
    expect(claude).toContain(".claude/skills/you-brain");
    expect(claude).toContain(".claude.json");
    expect(again.logs).toContain("已接入 1 项，跳过 0 项");
  });

  it("names --no-integrations when a non-interactive run has no decision flag", async () => {
    const base = await integrationLayout();
    const before = await filesUnder(base.homeDir);
    const { hooks } = harness(base, { isTTY: false, ask });
    await expect(runSetup(integrationFlags(), hooks)).rejects.toThrow(
      "--yes、--integrations <ids> 或 --no-integrations",
    );
    expect(await filesUnder(base.homeDir)).toEqual(before);
    expect(existsSync(join(base.paths.dataDir, "portrait-consent.json"))).toBe(false);

    function ask(): Promise<string> {
      throw new Error("should not ask");
    }
  });

  it("applies --integrations without prompting when there is no terminal", async () => {
    const base = await integrationLayout();
    const { logs, questions } = await runIntegrations(base, {
      integrations: "codex",
      tty: false,
    });
    expect(questions).toEqual([]);
    expect(logs.find((line) => line.startsWith("  codex"))).toContain(".codex/AGENTS.md");
    expect(logs.some((line) => line.startsWith("  claude-code"))).toBe(false);
    expect(existsSync(join(base.homeDir, ".codex/config.toml"))).toBe(true);
    expect(existsSync(join(base.homeDir, ".claude.json"))).toBe(false);
    expect(logs).toContain("已接入 4 项，跳过 0 项");
  });
});

function integrationFlags(extra: Partial<SetupFlags> = {}): SetupFlags {
  return {
    yes: false,
    inheritBrainhub: false,
    skipBrainhub: true,
    sources: [],
    ...extra,
  };
}

async function integrationLayout(): Promise<{
  homeDir: string;
  paths: YouBrainPaths;
  env: NodeJS.ProcessEnv;
}> {
  const base = await layout();
  await mkdir(base.paths.dataDir, { recursive: true });
  await mkdir(base.homeDir, { recursive: true });
  for (const dir of CLIENT_DIRS) await mkdir(join(base.homeDir, dir), { recursive: true });
  await writeFile(
    join(base.paths.dataDir, "setup.json"),
    `${JSON.stringify({
      version: 1,
      google: true,
      drive: true,
      brainhub: true,
      model: true,
      sources: true,
      integrations: false,
      backfill: true,
    })}\n`,
  );
  return base;
}

async function runIntegrations(
  base: { homeDir: string; paths: YouBrainPaths; env: NodeJS.ProcessEnv },
  options: {
    answers?: string[];
    yes?: boolean;
    integrations?: string;
    skipIntegrations?: boolean;
    tty?: boolean;
  } = {},
): Promise<{ logs: string[]; questions: string[] }> {
  const logs: string[] = [];
  const questions: string[] = [];
  const answers = [...(options.answers ?? [])];
  const { hooks } = harness(base, {
    isTTY: options.tty ?? true,
    log: (message) => logs.push(message),
    ask: async (question) => {
      questions.push(question);
      const next = answers.shift();
      if (next === undefined) throw new Error(`unexpected question: ${question}`);
      return next;
    },
  });
  await runSetup(
    integrationFlags({
      ...(options.yes ? { yes: true } : {}),
      ...(options.integrations !== undefined ? { integrations: options.integrations } : {}),
      ...(options.skipIntegrations ? { skipIntegrations: true } : {}),
    }),
    hooks,
  );
  expect(answers).toEqual([]);
  return { logs, questions };
}

function expectSummary(logs: string[]): void {
  expect(logs).toContain("将接入以下 AI 工具：");
  const expected: Array<[string, string[]]> = [
    ["claude-code", [".claude.json", ".claude/CLAUDE.md", ".claude/skills/you-brain", "you-brain-portrait"]],
    ["codex", [".codex/config.toml", ".codex/AGENTS.md", ".codex/skills/you-brain"]],
    ["grok-build", [".grok/config.toml", ".grok/AGENTS.md", ".grok/skills/you-brain"]],
    ["cursor", [".cursor/mcp.json", ".cursor/skills/you-brain", "you-brain-portrait"]],
    ["gemini-cli", [".gemini/settings.json", ".gemini/GEMINI.md", ".gemini/skills/you-brain"]],
  ];
  for (const [client, paths] of expected) {
    const line = logs.find((item) => item.startsWith(`  ${client}`));
    expect(line, client).toBeTruthy();
    for (const path of paths) expect(line).toContain(path);
  }
}

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(path);
    }
  }
  await walk(root);
  return found.sort();
}
