import { describe, expect, test } from "bun:test";

import { T3Automation } from "../../src/deck/t3/automation.js";

const baseUrl = "http://127.0.0.1:3773/";
const selection = { instanceId: "codex", model: "configured-model" };
const project = { id: "project-1", title: "Project", workspaceRoot: "/repo", defaultModelSelection: null };
const timestamp = "2026-11-16T00:00:00.000Z";
const later = "2026-11-16T00:01:00.000Z";
const message = { id: "assistant-1", role: "assistant", text: "Implemented and tested.", streaming: false, createdAt: timestamp };

function thread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-thread", projectId: project.id, modelSelection: selection, runtimeMode: "approval-required",
    interactionMode: "default", branch: "todo/task", worktreePath: "/worktrees/task", updatedAt: timestamp,
    latestTurn: { state: "completed", requestedAt: timestamp, assistantMessageId: message.id },
    session: { status: "ready", activeTurnId: null, lastError: null }, messages: [message], ...overrides,
  };
}

function harness(input: { shell?: unknown; detail?: unknown; status?: number } = {}) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const client = new T3Automation({
    getUrl: async () => baseUrl,
    getToken: async () => "synthetic-token",
    fetch: (async (value: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(value));
      requests.push({ method: init?.method ?? "GET", path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-token");
      expect(init?.redirect).toBe("error");
      if (input.status) return Response.json({ token: "sensitive-response-must-not-escape" }, { status: input.status });
      if (url.pathname === "/api/orchestration/shell") return Response.json(input.shell ?? { projects: [project], threads: [thread({ id: "historical-thread" })] });
      if (url.pathname === "/.well-known/t3/environment") return Response.json({ environmentId: "local-env" });
      if (url.pathname.startsWith("/api/orchestration/threads/")) return Response.json(input.detail ?? { thread: thread() });
      if (url.pathname === "/api/orchestration/dispatch") return Response.json({ sequence: 42 });
      throw new Error("Unexpected route");
    }) as typeof fetch,
  });
  return { client, requests };
}

describe("T3 TODO automation HTTP adapter", () => {
  test("loads projects from the authenticated shell without reading T3 storage", async () => {
    const { client, requests } = harness();
    expect(await client.projects()).toEqual([{ id: project.id, name: project.title, cwd: "/repo" }]);
    expect(requests).toHaveLength(1);
  });

  test("starts with one bootstrap command and stable thread, command and message identifiers", async () => {
    const { client, requests } = harness();
    const input = { projectId: project.id, title: "Implement", prompt: "Do the task", cwd: "/worktrees/task", branch: "todo/task", threadId: "new-task" };
    expect(await client.start(input)).toEqual({ threadId: "new-task", threadUrl: `${baseUrl}local-env/new-task` });
    const writes = requests.filter((request) => request.method === "POST");
    expect(writes).toHaveLength(1);
    const body = writes[0]?.body as Record<string, unknown>;
    expect(body.type).toBe("thread.turn.start");
    expect(body.commandId).toBe("u-brain-todo-start-new-task");
    expect(body.runtimeMode).toBe("approval-required");
    expect(body.modelSelection).toEqual(selection);
    expect(body.bootstrap).toMatchObject({ createThread: { projectId: project.id, worktreePath: input.cwd, branch: input.branch } });
    expect(body.message).toEqual({ messageId: "u-brain-todo-message-new-task", role: "user", text: input.prompt, attachments: [] });
  });

  test("recovers a known accepted start without sending another turn", async () => {
    const current = thread({ messages: [{ ...message, id: "u-brain-todo-message-task-thread", role: "user" }] });
    const { client, requests } = harness({ shell: { projects: [project], threads: [current] }, detail: { thread: current } });
    await client.start({ projectId: project.id, title: "Task", prompt: "Do it", cwd: "/worktrees/task", branch: "todo/task", threadId: "task-thread" });
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  test("new tasks inherit the latest project permission mode and default to auto without history", async () => {
    for (const [threads, expected] of [
      [[], "auto"],
      [[thread({ id: "older", runtimeMode: "full-access" }), thread({ id: "latest", runtimeMode: "auto-accept-edits", updatedAt: later })], "auto-accept-edits"],
      [[thread({ id: "other-project", projectId: "other", runtimeMode: "full-access" })], "auto"],
      [[thread({ id: "deleted", runtimeMode: "full-access", deletedAt: later })], "auto"],
      [[thread({ id: "unknown-mode", runtimeMode: "unsupported" })], "auto"],
    ] as const) {
      const { client, requests } = harness({ shell: { projects: [{ ...project, defaultModelSelection: selection }], threads } });
      await client.start({ projectId: project.id, title: "Task", prompt: "Do it", cwd: "/worktrees/task", branch: "todo/task", threadId: "new-task" });
      expect(requests.find((request) => request.method === "POST")?.body).toMatchObject({
        runtimeMode: expected, bootstrap: { createThread: { runtimeMode: expected } },
      });
    }
  });

  test("start recovery and rework retain the task thread's current permission mode", async () => {
    const current = thread({ runtimeMode: "auto", messages: [] });
    const { client, requests } = harness({
      shell: { projects: [project], threads: [current, thread({ id: "newer", runtimeMode: "full-access", updatedAt: later })] },
      detail: { thread: current },
    });
    await client.start({ projectId: project.id, title: "Task", prompt: "Do it", cwd: "/worktrees/task", branch: "todo/task", threadId: "task-thread" });
    expect(requests.find((request) => request.method === "POST")?.body).toMatchObject({ runtimeMode: "auto" });
    for (const mode of ["approval-required", "auto-accept-edits", "auto", "full-access"]) {
      const rework = harness({ detail: { thread: thread({ runtimeMode: mode }) } });
      await rework.client.followup("task-thread", "Fix it", "feedback");
      expect(rework.requests.find((request) => request.method === "POST")?.body).toMatchObject({ runtimeMode: mode });
    }
  });

  test("will not reuse a thread whose worktree changed", async () => {
    const { client, requests } = harness({ shell: { projects: [project], threads: [thread({ worktreePath: "/other" })] } });
    await expect(client.start({ projectId: project.id, title: "Task", prompt: "Do it", cwd: "/worktrees/task", branch: "todo/task", threadId: "task-thread" })).rejects.toThrow("不一致");
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  test("requires a configured project model rather than inventing a default", async () => {
    const { client } = harness({ shell: { projects: [project], threads: [] } });
    await expect(client.start({ projectId: project.id, title: "Task", prompt: "Do it", cwd: "/worktrees/task", branch: "todo/task", threadId: "new" })).rejects.toThrow("选择模型");
  });

  test("only a completed latest turn with its complete assistant message is ready", async () => {
    expect(await harness().client.inspect("task-thread")).toEqual({ state: "ready", summary: message.text });
    for (const overrides of [
      { latestTurn: null, session: { status: "idle", activeTurnId: null } },
      { latestTurn: { state: "running", requestedAt: timestamp, assistantMessageId: null } },
      { messages: [{ ...message, streaming: true }] },
      { messages: [{ ...message, id: "different-assistant" }] },
      { session: { status: "running", activeTurnId: "active" } },
    ]) {
      expect((await harness({ detail: { thread: thread(overrides) } }).client.inspect("task-thread")).state).toBe("running");
    }
  });

  test("new feedback cannot be mistaken for the preceding completed turn after a daemon restart", async () => {
    const current = thread({ messages: [message, { id: "new-user", role: "user", text: "Fix it", streaming: false, createdAt: later }] });
    expect((await harness({ detail: { thread: current } }).client.inspect("task-thread")).state).toBe("running");
  });

  test("error and interruption cannot be accepted for review, provider errors are withheld", async () => {
    const failed = await harness({ detail: { thread: thread({ session: { status: "error", activeTurnId: null, lastError: "sensitive-response-must-not-escape" } }) } }).client.inspect("task-thread");
    expect(failed.state).toBe("failed");
    expect(failed.error).not.toContain("sensitive-response");
    expect((await harness({ detail: { thread: thread({ latestTurn: { state: "interrupted", requestedAt: timestamp, assistantMessageId: null } }) } }).client.inspect("task-thread")).state).toBe("failed");
  });

  test("uses the persisted feedback commandId and recovers an accepted retry", async () => {
    const { client, requests } = harness();
    await client.followup("task-thread", "Fix the issue", "feedback-1");
    expect(requests.find((request) => request.method === "POST")?.body).toMatchObject({ commandId: "feedback-1", message: { messageId: "u-brain-todo-feedback-feedback-1", text: "Fix the issue" } });
    const recovered = harness({ detail: { thread: thread({ messages: [{ ...message, id: "u-brain-todo-feedback-feedback-1", role: "user" }] }) } });
    await recovered.client.followup("task-thread", "Fix the issue", "feedback-1");
    expect(recovered.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  test("rejects unsupported responses and withholds unauthenticated response contents", async () => {
    await expect(harness({ shell: { projects: [], threads: "invalid" } }).client.projects()).rejects.toThrow("格式不兼容");
    await expect(harness({ detail: { thread: thread({ latestTurn: {} }) } }).client.inspect("task-thread")).rejects.toThrow("格式不兼容");
    await expect(harness({ status: 401 }).client.projects()).rejects.toThrow("T3 未授权");
  });

  test("rejects nonlocal endpoints before requesting a credential or fetching", async () => {
    let accessed = false;
    const client = new T3Automation({ getUrl: async () => "https://remote.example/", getToken: async () => { accessed = true; return "synthetic"; } });
    await expect(client.projects()).rejects.toThrow("本机");
    expect(accessed).toBe(false);
  });

  test("issues one short lived local CLI credential, shares concurrent requests, and revokes it on close", async () => {
    const calls: string[][] = [];
    const client = new T3Automation({
      getUrl: async () => baseUrl,
      runCli: async (args) => { calls.push(args); return args.includes("issue") ? JSON.stringify({ token: "synthetic-cli-token", sessionId: "session-1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) : ""; },
      fetch: (async (_url: unknown, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-cli-token");
        return Response.json({ projects: [], threads: [] });
      }) as typeof fetch,
    });
    await Promise.all([client.projects(), client.projects()]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("1h");
    await client.close();
    expect(calls[1]).toEqual(["auth", "session", "revoke", "session-1"]);
  });
});
