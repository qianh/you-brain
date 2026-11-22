import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, mock } from "bun:test";

import { MemoryDrive } from "../../src/drive/memory-drive.js";
import type {
  DispatchDevicesResponse,
  DispatchFollowupBody,
  DispatchFollowupResponse,
  DispatchOutboxItemResponse,
  DispatchStartThreadBody,
  DispatchStartThreadResponse,
} from "../../src/http/types.js";
import { createLocalMcpServices } from "../../src/mcp/local.js";
import { createMcpServer, type McpDispatchClient, type McpServices } from "../../src/mcp/server.js";
import { SqliteStore } from "../../src/store/index.js";

function textOf(result: { [key: string]: unknown }): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  const block = content[0] as { text?: unknown } | undefined;
  return typeof block?.text === "string" ? block.text : "";
}

function makeServices(dispatch?: McpDispatchClient): McpServices {
  return {
    uploadSessions: async () => ({ dryRun: true, scanned: 0, uploaded: 0, warnings: [] }),
    searchSessions: async (input) => ({
      query: input.query,
      indexStatus: "fresh",
      searchMode: "keyword",
      results: [],
      warnings: [],
    }),
    getPortrait: async () => ({ variant: "full", portrait: "", warnings: [] }),
    getSession: async () => ({ source: "codex", conversationId: "c", content: "", updatedAt: "" }),
    notionSearch: async (input) => ({ query: input.query, hits: [] }),
    notionPage: async () => ({ id: "p", title: "", icon: null, coverUrl: null, lastEditedTime: "", blocks: [], markdown: "" }),
    hubStatus: async () => ({}),
    getToday: async () => ({ date: "2026-11-22", timeZone: "UTC", sessions: [] }),
    getTopics: async () => ({ topics: [] }),
    getTopic: async () => {
      throw new Error("unused");
    },
    updateTopic: async () => ({ ok: true, topicId: "t", events: [] }),
    getReminders: async () => ({ reminders: [] }),
    addPortraitCorrection: async () => {
      throw new Error("unused");
    },
    getPortraitCorrections: async () => ({ corrections: [] }),
    ...(dispatch ? { dispatch } : {}),
  };
}

async function callTool(services: McpServices, name: string, args: Record<string, unknown> = {}) {
  const server = createMcpServer(services);
  const client = new Client({ name: "dispatch-mcp-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP dispatch tools", () => {
  it("list_devices only returns enrolled devices with dispatch metadata", async () => {
    const state: DispatchDevicesResponse = {
      self: { deviceId: "vps-1", name: "VPS" },
      connected: true,
      enrolled: true,
      devices: [
        { id: "vps-1", name: "VPS", online: true, self: true, enrolled: true },
        {
          id: "mac-a",
          name: "Mac Studio",
          online: true,
          self: false,
          enrolled: true,
          dispatch: {
            enabled: true,
            t3: { ready: true },
            projects: [{ id: "p1", name: "you-brain" }],
            maxMode: "auto",
          },
        },
        {
          id: "legacy-1",
          name: "Old Mac",
          online: true,
          self: false,
          enrolled: false,
        },
      ],
    };
    const services = makeServices({
      devices: async () => state,
      startThread: async () => {
        throw new Error("unused");
      },
      getOutbox: async () => {
        throw new Error("unused");
      },
      followup: async () => {
        throw new Error("unused");
      },
    });

    const result = await callTool(services, "list_devices");
    expect(result.isError).not.toBe(true);
    const listed = (result.structuredContent as { devices: Array<{ id: string; acceptsDispatch: boolean }> }).devices;
    expect(listed.map((d) => d.id)).toEqual(["vps-1", "mac-a"]);
    expect(listed.find((d) => d.id === "mac-a")?.acceptsDispatch).toBe(true);
    expect(textOf(result)).toContain("Mac Studio");
    expect(textOf(result)).toContain("you-brain");
    expect(textOf(result)).not.toContain("Old Mac");
  });

  it("dispatch_to_device resolves names (unique/case-insensitive/ambiguous/missing), checks enabled & project whitelist", async () => {
    const startThread = mock(async (body: DispatchStartThreadBody): Promise<DispatchStartThreadResponse> => ({
      ok: true,
      dispatchId: "d-100",
      threadId: "t-100",
      threadUrl: "http://127.0.0.1:3773/env/t-100",
      mode: body.mode ?? "auto",
      capped: false,
      entry: {
        dispatchId: "d-100",
        to: body.to,
        deviceName: "Mac Studio",
        projectId: body.projectId,
        title: body.title,
        mode: body.mode ?? "auto",
        cmdId: "c-100",
        threadId: "t-100",
        threadUrl: "http://127.0.0.1:3773/env/t-100",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      },
    }));

    const state: DispatchDevicesResponse = {
      self: { deviceId: "vps-1", name: "VPS" },
      connected: true,
      enrolled: true,
      devices: [
        {
          id: "mac-a",
          name: "Mac Studio",
          online: true,
          self: false,
          enrolled: true,
          dispatch: {
            enabled: true,
            t3: { ready: true },
            projects: [
              { id: "p1", name: "You-Brain" },
              { id: "p2", name: "DupProj" },
              { id: "p3", name: "dupproj" },
            ],
            maxMode: "auto",
          },
        },
        {
          id: "mac-dup-1",
          name: "Work Mac",
          online: true,
          self: false,
          enrolled: true,
          dispatch: { enabled: true, t3: { ready: true }, projects: [{ id: "p1", name: "you-brain" }], maxMode: "auto" },
        },
        {
          id: "mac-dup-2",
          name: "work mac",
          online: true,
          self: false,
          enrolled: true,
          dispatch: { enabled: true, t3: { ready: true }, projects: [{ id: "p1", name: "you-brain" }], maxMode: "auto" },
        },
        {
          id: "mac-closed",
          name: "Closed Mac",
          online: true,
          self: false,
          enrolled: true,
          dispatch: { enabled: false, t3: { ready: true }, projects: [{ id: "p1", name: "you-brain" }], maxMode: "auto" },
        },
      ],
    };

    const services = makeServices({
      devices: async () => state,
      startThread,
      getOutbox: async () => {
        throw new Error("unused");
      },
      followup: async () => {
        throw new Error("unused");
      },
    });

    // 1. 唯一名称匹配（大小写不敏感）
    const ok = await callTool(services, "dispatch_to_device", {
      device: "mac studio",
      project: "you-brain",
      title: "检查日志",
      prompt: "帮我查一下错误",
      mode: "auto",
    });
    expect(ok.isError).not.toBe(true);
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(startThread).toHaveBeenCalledWith({
      to: "mac-a",
      projectId: "p1",
      title: "检查日志",
      prompt: "帮我查一下错误",
      mode: "auto",
    });
    expect(ok.structuredContent).toMatchObject({
      dispatchId: "d-100",
      threadUrl: "http://127.0.0.1:3773/env/t-100",
      mode: "auto",
    });

    // 2. 重名设备 -> 返回候选，不猜
    const dupDevice = await callTool(services, "dispatch_to_device", {
      device: "Work Mac",
      project: "you-brain",
      title: "任务",
      prompt: "干活",
    });
    expect(dupDevice.isError).toBe(true);
    expect(textOf(dupDevice)).toContain("AMBIGUOUS_DEVICE");
    expect(textOf(dupDevice)).toContain("mac-dup-1");
    expect(textOf(dupDevice)).toContain("mac-dup-2");

    // 3. 找不到设备 -> 返回候选
    const missingDevice = await callTool(services, "dispatch_to_device", {
      device: "NoSuchMac",
      project: "you-brain",
      title: "任务",
      prompt: "干活",
    });
    expect(missingDevice.isError).toBe(true);
    expect(textOf(missingDevice)).toContain("DEVICE_NOT_FOUND");
    expect(textOf(missingDevice)).toContain("Mac Studio");

    // 4. 对方未开启接收派活
    const closed = await callTool(services, "dispatch_to_device", {
      device: "Closed Mac",
      project: "you-brain",
      title: "任务",
      prompt: "干活",
    });
    expect(closed.isError).toBe(true);
    expect(textOf(closed)).toContain("DISPATCH_DISABLED");

    // 5. 项目不在对方白名单列表
    const badProject = await callTool(services, "dispatch_to_device", {
      device: "mac-a",
      project: "secret-repo",
      title: "任务",
      prompt: "干活",
    });
    expect(badProject.isError).toBe(true);
    expect(textOf(badProject)).toContain("PROJECT_NOT_ALLOWED");
    expect(textOf(badProject)).toContain("You-Brain");

    // 6. 重名项目 -> 返回候选，不猜
    const dupProject = await callTool(services, "dispatch_to_device", {
      device: "mac-a",
      project: "dupproj",
      title: "任务",
      prompt: "干活",
    });
    expect(dupProject.isError).toBe(true);
    expect(textOf(dupProject)).toContain("AMBIGUOUS_PROJECT");
    expect(textOf(dupProject)).toContain("p2");
    expect(textOf(dupProject)).toContain("p3");

    // 前面 5 个失败都不应发起 startThread
    expect(startThread).toHaveBeenCalledTimes(1);
  });

  it("get_dispatch_result and send_to_dispatch forward to daemon client", async () => {
    const getOutbox = mock(
      async (dispatchId: string, opts?: { refresh?: boolean }): Promise<DispatchOutboxItemResponse> => ({
        entry: {
          dispatchId,
          to: "mac-a",
          deviceName: "Mac Studio",
          projectId: "p1",
          title: "查日志",
          mode: "auto",
          cmdId: "c-1",
          threadId: "t-1",
          threadUrl: "http://127.0.0.1:3773/t-1",
          status: "done",
          createdAt: 1,
          updatedAt: 2,
          lastSummary: "已完成",
        },
        refreshed: opts?.refresh === true,
        ...(opts?.refresh ? { read: { state: "ready", summary: "实时刷新摘要", link: "https://t3/t-1" } } : {}),
      }),
    );
    const followup = mock(async (dispatchId: string, _body: DispatchFollowupBody): Promise<DispatchFollowupResponse> => ({
      ok: true,
      dispatchId,
      threadId: "t-1",
    }));

    const services = makeServices({
      devices: async () => ({ self: { deviceId: "vps", name: "VPS" }, connected: true, enrolled: true, devices: [] }),
      startThread: async () => {
        throw new Error("unused");
      },
      getOutbox,
      followup,
    });

    const result = await callTool(services, "get_dispatch_result", { dispatchId: "d-1", refresh: true });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "done", summary: "实时刷新摘要", refreshed: true });
    expect(textOf(result)).toContain("实时刷新摘要");

    const sent = await callTool(services, "send_to_dispatch", { dispatchId: "d-1", message: "补一个单测" });
    expect(sent.isError).not.toBe(true);
    expect(followup).toHaveBeenCalledWith("d-1", { prompt: "补一个单测" });
  });

  it("returns a clear DAEMON_NOT_RUNNING error immediately when daemon is offline", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "yb-mcp-dispatch-offline-"));
    const store = new SqliteStore(join(dataDir, "state.sqlite"));
    const services = createLocalMcpServices({
      store,
      search: {
        search: async (input) => ({
          query: input.query,
          indexStatus: "fresh",
          searchMode: "keyword",
          results: [],
          warnings: [],
        }),
      },
      drive: new MemoryDrive(),
      portraitDir: dataDir,
      dataDir,
      zone: { timeZone: "UTC", activeLimit: 10, historyDays: 30 },
    });

    try {
      const t0 = Date.now();
      const list = await callTool(services, "list_devices");
      const dispatch = await callTool(services, "dispatch_to_device", {
        device: "mac-a",
        project: "p1",
        title: "任务",
        prompt: "执行",
      });
      const read = await callTool(services, "get_dispatch_result", { dispatchId: "d-1" });
      const send = await callTool(services, "send_to_dispatch", { dispatchId: "d-1", message: "继续" });

      for (const res of [list, dispatch, read, send]) {
        expect(res.isError).toBe(true);
        expect(textOf(res)).toContain("DAEMON_NOT_RUNNING");
      }
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
