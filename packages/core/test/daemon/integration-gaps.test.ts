import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";
import {
  DRIVE_PATHS,
  createDefaultSharedConfig,
  parseSharedConfig,
} from "@you-brain/protocol";

import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { portraitConsentPath } from "../../src/portrait/consent.js";
import {
  makeDaemonDirs,
  readStatus,
  testClock,
  throwingEmbedder,
  type DaemonDirs,
} from "./helpers.js";

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function dirsFor(prefix: string): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs(prefix);
  roots.push(dirs.root);
  await mkdir(dirs.dataDir, { recursive: true });
  return dirs;
}

function start(
  dirs: DaemonDirs,
  extra: Parameters<typeof startDaemon>[0],
): Promise<YouBrainDaemon> {
  return startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname: "device-a",
    clock: testClock(),
    llm: null,
    embedder: throwingEmbedder,
    watch: false,
    signals: false,
    ...extra,
  }).then(async (daemon) => {
    started.push(daemon);
    await daemon.settled();
    return daemon;
  });
}

describe("integration gaps", () => {
  it("does not warn about consolidation until the role is enabled", async () => {
    const dirs = await dirsFor("you-brain-consolidate-");
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    await drive.put({
      path: DRIVE_PATHS.consolidateLease,
      bytes: Buffer.from(JSON.stringify({ finishedAt: "2020-01-01T00:00:00.000Z" })),
      mimeType: "application/json",
    });
    const daemon = await start(dirs, { clock, drive, sourceRoots: {} });
    const disabled = await readStatus(daemon);
    expect(disabled.consolidation).toEqual({
      enabled: false,
      lastFinishedAt: null,
      stale: false,
      status: "disabled",
    });
    expect(disabled.warnings.some((warning) => warning.code === "CONSOLIDATION_STALE")).toBe(
      false,
    );

    const put = await fetch(`${daemon.baseUrl}/api/roles`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ consolidation: { enabled: true } }),
    });
    expect(put.ok).toBe(true);
    const enabled = await readStatus(daemon);
    expect(enabled.consolidation).toMatchObject({
      enabled: true,
      lastFinishedAt: "2020-01-01T00:00:00.000Z",
      stale: true,
      status: "stale",
    });
    expect(enabled.warnings).toContainEqual({
      code: "CONSOLIDATION_STALE",
      message: "超过 1 天未沉淀",
    });
  });

  it("applies consented coding blocks on startup and again when the path changes", async () => {
    const dirs = await dirsFor("you-brain-consent-daemon-");
    await mkdir(join(dirs.homeDir, ".claude"), { recursive: true });
    await mkdir(join(dirs.homeDir, ".codex"), { recursive: true });
    await writeFile(
      portraitConsentPath(dirs.dataDir),
      `${JSON.stringify({
        itemIds: ["claude-code:mcp", "claude-code:portrait", "codex:portrait"],
        fingerprint: null,
      })}\n`,
    );
    const daemon = await start(dirs, { drive: null, sourceRoots: {} });
    const claude = join(dirs.homeDir, ".claude", "CLAUDE.md");
    const codex = join(dirs.homeDir, ".codex", "AGENTS.md");
    expect(await readFile(claude, "utf8")).toContain("@~/.you-brain/portrait/coding.md");
    expect(await readFile(codex, "utf8")).toContain("coding.md");
    await writeFile(claude, "# mine\n\n<!-- you-brain:start v1 -->\ntampered\n<!-- you-brain:end -->\n");

    const variants = createDefaultSharedConfig().portrait.variants.map((variant) =>
      variant.id === "coding"
        ? { ...variant, path: "digital-twin/JOHN-TWIN-coding-v2.md" }
        : variant,
    );
    const put = await fetch(`${daemon.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ portrait: { variants } }),
    });
    expect(put.ok).toBe(true);
    const restored = await readFile(claude, "utf8");
    expect(restored).toContain("# mine");
    expect(restored).toContain("@~/.you-brain/portrait/coding.md");
    expect(restored).not.toContain("tampered");
    const consent = JSON.parse(await readFile(portraitConsentPath(dirs.dataDir), "utf8")) as {
      itemIds: string[];
      fingerprint: string | null;
    };
    expect(consent.itemIds).toContain("claude-code:mcp");
    expect(consent.fingerprint).toContain("JOHN-TWIN-coding-v2.md");
  });

  it("still starts when the consent file is corrupt", async () => {
    const dirs = await dirsFor("you-brain-consent-bad-");
    await writeFile(portraitConsentPath(dirs.dataDir), "{");
    const daemon = await start(dirs, { drive: null, sourceRoots: {} });
    const status = await readStatus(daemon);
    expect(status.consolidation.status).toBe("disabled");
  });

  it("uploads tool calls and redacted text, skipping excluded directories", async () => {
    const dirs = await dirsFor("you-brain-capture-");
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const shared = parseSharedConfig({
      capture: {
        keepToolCalls: true,
        includeSubagents: false,
        redact: true,
        sources: {
          "claude-code": { enabled: true, paths: [dirs.sourceDir], exclude: ["hidden"] },
          codex: { enabled: false },
          "grok-build": { enabled: false },
          cursor: { enabled: false },
          "gemini-cli": { enabled: false },
        },
      },
    });
    await writeFile(join(dirs.dataDir, "shared.json"), `${JSON.stringify(shared)}\n`);
    await mkdir(join(dirs.sourceDir, "hidden"), { recursive: true });
    const assistant = (sessionId: string, text: string, sidechain = false) =>
      JSON.stringify({
        type: "assistant",
        isSidechain: sidechain,
        sessionId,
        timestamp: "2026-10-18T02:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text },
            { type: "tool_use", name: "Read", input: { path: "a.ts" } },
          ],
        },
      });
    // A real conversation starts with a question the user typed; the injected context a
    // CLI writes on startup is not enough to make the session worth keeping.
    const question = (sessionId: string) =>
      JSON.stringify({
        type: "user",
        isSidechain: false,
        sessionId,
        timestamp: "2026-10-18T01:59:00.000Z",
        message: { role: "user", content: "why does this fail" },
      });
    await writeFile(
      join(dirs.sourceDir, "visible.jsonl"),
      `${question("visible-1")}\n${assistant("visible-1", "Authorization: Bearer cursor-secret-value")}\n`,
    );
    await writeFile(
      join(dirs.sourceDir, "hidden", "secret.jsonl"),
      `${assistant("hidden-1", "hidden-conversation")}\n`,
    );
    await writeFile(
      join(dirs.sourceDir, "side.jsonl"),
      `${assistant("side-1", "sidechain-only-text", true)}\n`,
    );
    const daemon = await start(dirs, { clock, drive });
    await daemon.settled();
    await clock.advance(5 * 60_000);
    await daemon.settled();
    const files = await drive.list({ prefix: "inbox/" });
    const markdown = (
      await Promise.all(files.filter((file) => file.path.endsWith(".md")).map((file) => drive.read(file.id)))
    )
      .map((object) => object.bytes.toString("utf8"))
      .join("\n");
    expect(markdown).toContain("[tool] Read");
    expect(markdown).toContain("[REDACTED]");
    expect(markdown).not.toContain("cursor-secret-value");
    expect(markdown).not.toContain("hidden-1");
    expect(markdown).not.toContain("sidechain-only-text");
  });
});
