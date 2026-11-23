import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateKeyPair, newNonce, signCommand, type CommandSigningFields } from "@you-brain/protocol";

import { DispatchExecutor, normalizeDispatchPolicy, type DispatchSender, type DispatchT3Port } from "../../src/dispatch/index.js";

const SELF = "device-self";
const PEER = "device-peer";

function fakeT3(): DispatchT3Port & { launches: string[] } {
  const launches: string[] = [];
  return {
    launches,
    projects: async () => [
      { id: "p1", name: "you-brain", cwd: "/repo" },
      { id: "p-new", name: "新项目", cwd: "/new" },
    ],
    launchThread: async (input) => {
      launches.push(input.projectId);
      return { threadId: `t-${launches.length}`, threadUrl: "http://127.0.0.1:3773/x" };
    },
    followup: async () => undefined,
    inspect: async () => ({ state: "running", summary: "" }),
    threadStates: async () => [],
    latestAnswer: async () => "",
  } as DispatchT3Port & { launches: string[] };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function make(members: () => Promise<DispatchSender[]>) {
  const dir = await mkdtemp(join(tmpdir(), "yb-dispatch-trust-"));
  dirs.push(dir);
  const keys = generateKeyPair();
  const t3 = fakeT3();
  const now = 1_760_000_000_000;
  const executor = new DispatchExecutor({ dataDir: dir, deviceId: SELF, now: () => now, t3, emitEvent: () => undefined, members });
  const frame = (projectId: string, privateKey = keys.privateKey, kind: "t3.start" | "t3.projects" = "t3.start") => {
    const fields: CommandSigningFields = {
      cmdId: `c-${newNonce()}`,
      from: PEER,
      to: SELF,
      ts: now,
      nonce: newNonce(),
      cmd:
        kind === "t3.start"
          ? { kind, args: { projectId, title: "标题", prompt: "做这件事", dispatchId: `d-${newNonce()}` } }
          : { kind, args: {} },
    };
    return { t: "cmd" as const, ...fields, sig: signCommand(privateKey, fields) };
  };
  return { executor, keys, t3, frame };
}

describe("入网设备互相信任", () => {
  test("旧策略文件没有新字段时都当关闭", () => {
    const policy = normalizeDispatchPolicy({ enabled: true, allowedSenders: [], allowedProjects: [] });
    expect(policy.trustEnrolled).toBe(false);
    expect(policy.allProjects).toBe(false);
    expect(policy.autoConfigured).toBe(false);
  });

  test("开了信任入网设备：名单外但在云盘成员里的设备能派活，全部项目（含新项目）都能派", async () => {
    let members: DispatchSender[] = [];
    const h = await make(async () => members);
    members = [{ deviceId: PEER, name: "VPS 主控", publicKey: h.keys.publicKey }];
    await h.executor.updatePolicy({ enabled: true, trustEnrolled: true, allProjects: true, allowedSenders: [], allowedProjects: [] });

    const started = await h.executor.handle(h.frame("p-new"));
    expect(started.ok).toBe(true);
    expect(h.t3.launches).toEqual(["p-new"]);

    const listed = await h.executor.handle(h.frame("", h.keys.privateKey, "t3.projects"));
    expect(listed).toMatchObject({ ok: true, result: { projects: [{ id: "p1" }, { id: "p-new" }] } });
    expect((await h.executor.hello()).projects.map((project) => project.id)).toEqual(["p1", "p-new"]);
  });

  test("成员的公钥对不上照样拒绝；不在成员里也拒绝", async () => {
    const other = generateKeyPair();
    const h = await make(async () => [{ deviceId: PEER, name: "VPS 主控", publicKey: other.publicKey }]);
    await h.executor.updatePolicy({ enabled: true, trustEnrolled: true, allProjects: true });
    expect(await h.executor.handle(h.frame("p1"))).toMatchObject({ ok: false });

    const none = await make(async () => []);
    await none.executor.updatePolicy({ enabled: true, trustEnrolled: true, allProjects: true });
    expect(await none.executor.handle(none.frame("p1"))).toMatchObject({ ok: false });
    expect(none.t3.launches).toEqual([]);
  });

  test("关掉信任入网设备后，只认手动名单；关掉全部项目后只认项目白名单", async () => {
    const h = await make(async () => [{ deviceId: PEER, name: "VPS 主控", publicKey: "unused" }]);
    await h.executor.updatePolicy({ enabled: true, trustEnrolled: false, allProjects: false, allowedProjects: ["p1"] });
    expect(await h.executor.handle(h.frame("p1"))).toMatchObject({ ok: false });

    await h.executor.updatePolicy({ allowedSenders: [{ deviceId: PEER, name: "手动", publicKey: h.keys.publicKey }] });
    expect(await h.executor.handle(h.frame("p-new"))).toMatchObject({ ok: false });
    expect((await h.executor.handle(h.frame("p1"))).ok).toBe(true);
  });

  test("查看 T3 也认云盘成员", async () => {
    const h = await make(async () => [{ deviceId: PEER, name: "VPS 主控", publicKey: h.keys.publicKey }]);
    await h.executor.updatePolicy({ viewT3: true, trustEnrolled: true });
    const result = await h.executor.authorizeView(h.frame("", h.keys.privateKey, "t3.projects"));
    expect(result).toMatchObject({ ok: true, sender: { deviceId: PEER } });
  });
});
