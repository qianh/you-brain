import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeckService } from "../../src/deck/service.js";
import { renderDshPatch } from "../../src/deck/dsh/patch.js";
// @ts-expect-error 插件是纯 JS 模块（随 App 打包），没有类型声明。
import { createTools } from "../../../../sidecars/dsh-host/plugins/u-brain-bridge.mjs";

type Tool = {
  name: string;
  parameters: Record<string, { type: string; required?: boolean }>;
  execute(args: Record<string, unknown>, exec?: { signal?: AbortSignal }): Promise<string>;
};

describe("u-brain-bridge plugin tools", () => {
  const find = (tools: Tool[], name: string): Tool => {
    const tool = tools.find((item) => item.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool;
  };

  it("exposes three tools with the expected required parameters", () => {
    const tools = createTools() as Tool[];
    expect(tools.map((tool) => tool.name)).toEqual(["gui_app_list", "gui_app_ask", "gui_app_replies"]);
    expect(find(tools, "gui_app_ask").parameters.app?.required).toBe(true);
    expect(find(tools, "gui_app_ask").parameters.prompt?.required).toBe(true);
    expect(find(tools, "gui_app_ask").parameters.wait_seconds?.required).toBeUndefined();
    expect(find(tools, "gui_app_replies").parameters.since_ms?.required).toBe(true);
  });

  it("lists apps with availability and recoverability", async () => {
    const tools = createTools({
      api: async () => ({
        apps: [
          { id: "grok-bot", displayName: "Grok Bot", available: true, detail: "就绪", recoverable: true },
          { id: "muse", displayName: "Muse", available: false, detail: "App 未运行", recoverable: false },
        ],
      }),
    }) as Tool[];
    const text = await find(tools, "gui_app_list").execute({});
    expect(text).toContain("grok-bot（Grok Bot）：就绪；可自动回收回复");
    expect(text).toContain("muse（Muse）：不可用——App 未运行；回复需在 App 里查看");
  });

  it("ask: sends once, polls until replies show up, and returns them", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    let polls = 0;
    const slept: number[] = [];
    let clock = 0;
    const tools = createTools({
      api: async (path: string, init: { body?: unknown }) => {
        calls.push({ path, body: init.body });
        if (path === "/api/deck/bridge/send") return { sentAtMs: 1234, recoverable: true };
        polls += 1;
        return { replies: polls >= 3 ? ["答案一", "答案二"] : [] };
      },
      sleep: async (ms: number) => { slept.push(ms); clock += ms; },
      now: () => clock,
      pollMs: 20_000,
    }) as Tool[];
    const text = await find(tools, "gui_app_ask").execute({ app: "grok-bot", prompt: "做事", wait_seconds: 120 });
    expect(text).toContain("来自 grok-bot 的回复");
    expect(text).toContain("答案一\n\n---\n\n答案二");
    expect(calls.filter((call) => call.path === "/api/deck/bridge/send")).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ app: "grok-bot", prompt: "做事" });
    expect(calls.filter((call) => call.path === "/api/deck/bridge/replies")).toHaveLength(3);
    expect(calls[1]?.body).toEqual({ app: "grok-bot", sinceMs: 1234 });
    expect(slept).toEqual([20_000, 20_000, 20_000]);
  });

  it("ask: gives up after the wait budget and tells how to check later; caps the budget", async () => {
    let clock = 0;
    let polls = 0;
    const tools = createTools({
      api: async (path: string) => (path.endsWith("send") ? { sentAtMs: 99, recoverable: true } : (polls += 1, { replies: [] })),
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
      pollMs: 20_000,
    }) as Tool[];
    const text = await find(tools, "gui_app_ask").execute({ app: "grok-bot", prompt: "x", wait_seconds: 50 });
    expect(text).toContain("50 秒内没有等到新回复");
    expect(text).toContain("since_ms=99");
    expect(polls).toBe(3); // 20s + 20s + 10s
    clock = 0; polls = 0;
    await find(tools, "gui_app_ask").execute({ app: "grok-bot", prompt: "x", wait_seconds: 99_999 });
    expect(clock).toBeLessThanOrEqual(300_000);
  });

  it("ask: an app whose replies cannot be recovered returns immediately after sending", async () => {
    let polled = false;
    const tools = createTools({
      api: async (path: string) => { if (!path.endsWith("send")) polled = true; return { sentAtMs: 1, recoverable: false }; },
      sleep: async () => undefined,
    }) as Tool[];
    const text = await find(tools, "gui_app_ask").execute({ app: "muse", prompt: "x" });
    expect(text).toContain("已把任务投递进 muse");
    expect(polled).toBe(false);
  });

  it("ask: stops polling when the call is cancelled", async () => {
    const controller = new AbortController();
    let polls = 0;
    const tools = createTools({
      api: async (path: string) => (path.endsWith("send") ? { sentAtMs: 1, recoverable: true } : (polls += 1, { replies: [] })),
      sleep: async () => { controller.abort(); },
      now: () => 0,
    }) as Tool[];
    const text = await find(tools, "gui_app_ask").execute({ app: "grok-bot", prompt: "x" }, { signal: controller.signal });
    expect(polls).toBe(0);
    expect(text).toContain("没有等到新回复");
  });

  it("surfaces daemon errors to the model instead of swallowing them", async () => {
    const tools = createTools({ api: async () => { throw new Error("需要授予 U-Brain「辅助功能」权限"); } }) as Tool[];
    await expect(find(tools, "gui_app_ask").execute({ app: "grok-bot", prompt: "x" })).rejects.toThrow("辅助功能");
  });

  it("the default transport reads port and token from daemon.json and calls the local daemon", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-daemon-"));
    const seen: Array<{ url: string; auth: string | null; body: string }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        seen.push({ url: new URL(request.url).pathname, auth: request.headers.get("authorization"), body: await request.text() });
        return Response.json({ apps: [{ id: "grok-bot", displayName: "Grok Bot", available: true, detail: "就绪", recoverable: true }] });
      },
    });
    const previous = process.env.YOU_BRAIN_DATA_DIR;
    try {
      await writeFile(join(dir, "daemon.json"), JSON.stringify({ port: server.port, token: "tok-123", pid: 1 }));
      process.env.YOU_BRAIN_DATA_DIR = dir;
      const text = await find(createTools() as Tool[], "gui_app_list").execute({});
      expect(text).toContain("grok-bot");
      expect(seen[0]).toMatchObject({ url: "/api/deck/bridge/apps", auth: "Bearer tok-123" });
      // daemon 没运行：给出可读的原因。
      await rm(join(dir, "daemon.json"));
      await expect(find(createTools() as Tool[], "gui_app_list").execute({})).rejects.toThrow("没有运行");
    } finally {
      if (previous === undefined) delete process.env.YOU_BRAIN_DATA_DIR;
      else process.env.YOU_BRAIN_DATA_DIR = previous;
      server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("deck service GUI bridge", () => {
  async function service(overrides: Partial<NonNullable<ConstructorParameters<typeof DeckService>[0]["guiBridge"]>> = {}) {
    const dir = await mkdtemp(join(tmpdir(), "deck-bridge-"));
    const sent: Array<[string, string]> = [];
    const instance = new DeckService({
      dataDir: dir, homeDir: dir, warmDsh: false,
      guiBridge: {
        status: async (id) => ({ id, displayName: id, available: id === "grok-bot", detail: id === "grok-bot" ? "就绪" : "App 未运行" }),
        dispatch: async (id, prompt) => { sent.push([id, prompt]); return { sentAtMs: 4242 }; },
        replies: async (_id, since) => [`回复@${since}`],
        ...overrides,
      },
    });
    return { instance, dir, sent };
  }

  it("lists the configured apps with status and recoverability", async () => {
    const { instance, dir } = await service();
    try {
      const apps = await instance.bridgeApps();
      expect(apps.map((app) => [app.id, app.available, app.recoverable])).toEqual([["grok-bot", true, true], ["muse", false, false]]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("sends and recovers through the bridge, and rejects unknown apps and empty prompts", async () => {
    const { instance, dir, sent } = await service();
    try {
      expect(await instance.bridgeSend("grok-bot", "任务")).toEqual({ sentAtMs: 4242, recoverable: true });
      expect(await instance.bridgeSend("muse", "任务")).toEqual({ sentAtMs: 4242, recoverable: false });
      expect(sent).toEqual([["grok-bot", "任务"], ["muse", "任务"]]);
      expect(await instance.bridgeReplies("grok-bot", 4242)).toEqual(["回复@4242"]);
      await expect(instance.bridgeSend("nope", "x")).rejects.toThrow("未知 GUI App");
      await expect(instance.bridgeSend("grok-bot", "  ")).rejects.toThrow("不能为空");
      await expect(instance.bridgeReplies("nope", 0)).rejects.toThrow("未知 GUI App");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("propagates a bridge failure such as a missing accessibility permission", async () => {
    const { instance, dir } = await service({ dispatch: async () => { throw new Error("需要授予 U-Brain「辅助功能」权限"); } });
    try {
      await expect(instance.bridgeSend("grok-bot", "x")).rejects.toThrow("辅助功能");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("local plugin rows in the dsh patch", () => {
  it("mounts a local plugin by absolute path", () => {
    const text = renderDshPatch({ plugins: [], localPlugins: [{ id: "u-brain-bridge", path: "/app/sidecar/plugins/u-brain-bridge.mjs" }] });
    expect(text).toContain("- id: u-brain-bridge");
    expect(text).toContain('name: "/app/sidecar/plugins/u-brain-bridge.mjs"');
  });
});
