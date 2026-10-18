import { resolve } from "node:path";

import { describe, expect, it } from "bun:test";

import { YouBrainError } from "../../src/domain/errors.js";
import { assertSupportedPlatform } from "../../src/domain/platform.js";
import { platformPaths, portraitFile } from "../../src/domain/paths.js";

describe("platform paths", () => {
  it("uses the macOS data directory and the AI output directory", () => {
    const paths = platformPaths({
      platform: "darwin",
      homeDir: "/Users/test",
      env: {},
    });
    expect(paths.dataDir).toBe(
      "/Users/test/Library/Application Support/you-brain",
    );
    expect(paths.configFile).toBe(
      "/Users/test/Library/Application Support/you-brain/config.toml",
    );
    expect(paths.stateFile).toBe(
      "/Users/test/Library/Application Support/you-brain/state.sqlite",
    );
    expect(paths.searchIndexFile).toBe(
      "/Users/test/Library/Application Support/you-brain/search-index.sqlite",
    );
    expect(paths.modelCacheDir).toBe(
      "/Users/test/Library/Application Support/you-brain/models",
    );
    expect(paths.daemonFile).toBe(
      "/Users/test/Library/Application Support/you-brain/daemon.json",
    );
    expect(paths.outputDir).toBe("/Users/test/.you-brain");
    expect(paths.todayFile).toBe("/Users/test/.you-brain/TODAY.md");
    expect(paths.topicsFile).toBe("/Users/test/.you-brain/TOPICS.md");
    expect(paths.remindersFile).toBe("/Users/test/.you-brain/REMINDERS.md");
    expect(portraitFile(paths, "coding")).toBe(
      "/Users/test/.you-brain/portrait/coding.md",
    );
  });

  it("uses XDG_STATE_HOME on Linux and keeps ~/.you-brain", () => {
    const defaults = platformPaths({
      platform: "linux",
      homeDir: "/home/test",
      env: {},
    });
    expect(defaults.dataDir).toBe("/home/test/.local/state/you-brain");
    expect(defaults.outputDir).toBe("/home/test/.you-brain");

    const xdg = platformPaths({
      platform: "linux",
      homeDir: "/home/test",
      env: { XDG_STATE_HOME: "/xdg/state" },
    });
    expect(xdg.dataDir).toBe("/xdg/state/you-brain");
    expect(xdg.outputDir).toBe("/home/test/.you-brain");
  });

  it("lets YOU_BRAIN_DATA_DIR and YOU_BRAIN_HOME override both trees", () => {
    const paths = platformPaths({
      platform: "darwin",
      homeDir: "/Users/test",
      env: {
        YOU_BRAIN_DATA_DIR: "~/yb-data",
        YOU_BRAIN_HOME: "/tmp/yb-home",
      },
    });
    expect(paths.dataDir).toBe("/Users/test/yb-data");
    expect(paths.configFile).toBe("/Users/test/yb-data/config.toml");
    expect(paths.outputDir).toBe("/tmp/yb-home");
    expect(paths.todayFile).toBe("/tmp/yb-home/TODAY.md");

    const relative = platformPaths({
      platform: "linux",
      homeDir: "/home/test",
      env: { YOU_BRAIN_DATA_DIR: "relative-data", YOU_BRAIN_HOME: "" },
    });
    expect(relative.dataDir).toBe(resolve("relative-data"));
    expect(relative.outputDir).toBe("/home/test/.you-brain");
  });

  it("rejects an unsupported platform even when the data dir is overridden", () => {
    expect(() => assertSupportedPlatform("win32")).toThrow(YouBrainError);
    try {
      assertSupportedPlatform("win32");
    } catch (error) {
      expect(error).toBeInstanceOf(YouBrainError);
      expect((error as YouBrainError).code).toBe("PLATFORM_UNSUPPORTED");
    }
    expect(() =>
      platformPaths({
        platform: "win32",
        homeDir: "/Users/test",
        env: { YOU_BRAIN_DATA_DIR: "/tmp/yb" },
      }),
    ).toThrow(YouBrainError);
    expect(() => portraitFile(
      platformPaths({ platform: "darwin", homeDir: "/Users/test", env: {} }),
      "../coding",
    )).toThrow();
  });
});
