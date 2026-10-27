import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "bun:test";

import { TWIN_CLAIMS_SYSTEM_PROMPT, TWIN_MERGE_SYSTEM_PROMPT } from "../../src/consolidate/index.js";
import { TWIN_PROBES_SYSTEM_PROMPT } from "../../src/consolidate/prompt.js";
import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { INTERVALS } from "../../src/daemon/schedule.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { createDaemonClient } from "../../src/http/client.js";
import type { ConsolidateActionResult, PortraitCorrectionView } from "../../src/http/types.js";
import {
  CLOCK_START,
  fakeBackend,
  makeDaemonDirs,
  readStatus,
  testClock,
  throwingEmbedder,
  type DaemonDirs,
} from "../daemon/helpers.js";

const TEXT = "B4纠正把工作方式写成先测后改";
const SECTION = "工作方式";
const VERSION_LINE = "版本 v2.0.0 · 2026-10-01 · 变更见 changelog";
const ORIGINAL = ["# 数字分身 · 人格", VERSION_LINE, "", "## 工作方式", "保持原结构。数据留在自己的 Drive。", "统一用 bun。回复用中文。", ""].join("\n");
const CODING = ["# 数字分身 · 编码", VERSION_LINE, "", "## 1. 授权与边界", "提问不等于授权改代码。", ""].join("\n");

const daemons: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portrait corrections across two devices", () => {
  it(
    "merges a correction from the other device on the next consolidation",
    async () => {
      const clock = testClock();
      const drive = new MemoryDrive({ now: () => clock.now() });
      const prompts: string[] = [];
      const llm = fakeBackend(async (request) => {
        if (request.system === TWIN_MERGE_SYSTEM_PROMPT) {
          prompts.push(request.user);
          return JSON.stringify({
            bump: "minor",
            changelog: ["full · 工作方式：先测后改"],
            edits: [
              { layer: "full", heading: "## 工作方式", text: "## 工作方式\n保持原结构。数据留在自己的 Drive。\n先测后改。" },
            ],
          });
        }
        if (request.system === TWIN_CLAIMS_SYSTEM_PROMPT) return JSON.stringify({ claims: [] });
        if (request.system === TWIN_PROBES_SYSTEM_PROMPT) return JSON.stringify({ probes: [] });
        if (request.system.includes("话题概要")) {
          return JSON.stringify({ summary: "发布清单已整理", nextStep: "" });
        }
        if (request.system.includes("合并建议")) return JSON.stringify({ pairs: [] });
        return JSON.stringify({});
      });
      await drive.put({
        path: "digital-twin/JOHN-DIGITAL-TWIN-latest.md",
        bytes: Buffer.from(ORIGINAL, "utf8"),
        mimeType: "text/markdown",
      });
      await drive.put({
        path: "digital-twin/JOHN-TWIN-coding.md",
        bytes: Buffer.from(CODING, "utf8"),
        mimeType: "text/markdown",
      });
      const dirsA = await track("a");
      const dirsB = await track("b");
      const daemonA = await startOne(dirsA, "device-a", clock, drive, llm);
      const daemonB = await startOne(dirsB, "device-b", clock, drive, llm);
      const idA = (await readStatus(daemonA)).deviceId;
      expect(
        (
          await putJson(daemonA, "/api/roles", {
            mainDevice: idA,
            consolidation: { enabled: true, time: "23:00" },
          })
        ).status,
      ).toBe(200);

      const clientB = createDaemonClient({ port: daemonB.port, token: daemonB.token });
      const added = await clientB.addPortraitCorrection({ section: SECTION, text: TEXT });
      expect(added.correction).toMatchObject({ variant: "full", section: SECTION, text: TEXT, status: "pending" });

      await clock.advance(INTERVALS.flushMs);
      await daemonA.settled();
      await daemonB.settled();
      expect((await postJson<{ started: boolean }>(daemonA, "/api/actions/sync", {})).started).toBe(true);

      const consolidated = await postJson<ConsolidateActionResult>(daemonA, "/api/actions/consolidate", {});
      expect(consolidated.ok).toBe(true);
      expect(consolidated.steps.find((step) => step.id === "portrait")).toEqual({ id: "portrait", ok: true });
      expect(prompts.some((prompt) => prompt.includes(TEXT))).toBe(true);

      const clientA = createDaemonClient({ port: daemonA.port, token: daemonA.token });
      const onA = await appliedCorrection(clientA, added.correction.correctionId);
      expect(onA).toMatchObject({
        status: "applied",
        section: SECTION,
        text: TEXT,
        snapshot: "JOHN-DIGITAL-TWIN-v2.1.0-2026-10-18.md",
      });

      await clock.advance(INTERVALS.flushMs);
      await daemonA.settled();
      await daemonB.settled();
      expect((await postJson<{ started: boolean }>(daemonB, "/api/actions/sync", {})).started).toBe(true);
      const onB = await appliedCorrection(clientB, added.correction.correctionId);
      expect(onB).toMatchObject({
        status: "applied",
        snapshot: "JOHN-DIGITAL-TWIN-v2.1.0-2026-10-18.md",
      });
    },
    120_000,
  );
});

async function appliedCorrection(
  client: ReturnType<typeof createDaemonClient>,
  correctionId: string,
): Promise<PortraitCorrectionView> {
  const listed = await client.portraitCorrections("full");
  const found = listed.corrections.find((item) => item.correctionId === correctionId);
  if (!found) throw new Error(`missing correction ${correctionId}`);
  return found;
}

async function track(name: string): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs(`you-brain-correction-${name}-`);
  roots.push(dirs.root);
  return dirs;
}

async function startOne(
  dirs: DaemonDirs,
  hostname: string,
  clock: ReturnType<typeof testClock>,
  drive: MemoryDrive,
  llm: ReturnType<typeof fakeBackend>,
): Promise<YouBrainDaemon> {
  const daemon = await startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname,
    clock,
    drive,
    llm,
    embedder: throwingEmbedder,
    sourceRoots: { "claude-code": [dirs.sourceDir] },
    watch: false,
    signals: false,
  });
  daemons.push(daemon);
  await daemon.settled();
  return daemon;
}

async function postJson<T>(daemon: YouBrainDaemon, path: string, body: unknown): Promise<T> {
  const response = await send(daemon, path, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function putJson(daemon: YouBrainDaemon, path: string, body: unknown): Promise<Response> {
  return send(daemon, path, { method: "PUT", body: JSON.stringify(body) });
}

function send(daemon: YouBrainDaemon, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${daemon.token}`);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${daemon.baseUrl}${path}`, { ...init, headers });
}
