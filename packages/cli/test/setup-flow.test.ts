import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
