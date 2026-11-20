import { describe, expect, test } from "bun:test";

import { T3Automation } from "../../src/deck/t3/automation.js";
import { fakeT3, fakeThread, type FakeProject, type FakeThread } from "./t3-mcp-fake.js";

const baseUrl = "http://127.0.0.1:3773/";
const selection = { instanceId: "codex", model: "configured-model" };
const project: FakeProject = { id: "project-1", title: "Project", workspaceRoot: "/repo", defaultModelSelection: null };
const startInput = { projectId: project.id, title: "Implement", prompt: "Do the task", cwd: "/worktrees/new", branch: "todo/new", requestId: "req-1" };

function harness(input: { projects?: FakeProject[]; threads?: FakeThread[] } = {}) {
  const t3 = fakeT3({ projects: input.projects ?? [project], threads: input.threads ?? [] });
  const client = new T3Automation({ getUrl: async () => baseUrl, getToken: async () => t3.token, fetch: t3.fetch });
  const launches = () => t3.calls.filter((call) => call.name === "t3_thread_launch");
  const sends = () => t3.calls.filter((call) => call.name === "t3_thread_send");
  return { client, t3, launches, sends };
}

describe("T3 TODO automation MCP adapter", () => {
  test("loads projects through one MCP session without reading T3 storage", async () => {
    const { client, t3 } = harness({ projects: [project, { ...project, id: "gone", deletedAt: "2026-11-16T00:00:00.000Z" }] });
    expect(await client.projects()).toEqual([{ id: project.id, name: project.title, cwd: "/repo" }]);
    await client.projects();
    expect(t3.state.initializes).toBe(1);
  });

  test("reopens an expired MCP session once", async () => {
    const { client, t3 } = harness();
    await client.projects();
    t3.state.expireSession = true;
    expect(await client.projects()).toHaveLength(1);
    expect(t3.state.initializes).toBe(2);
  });

  test("registers an existing folder without creating it, or lets T3 create a fresh repository by name", async () => {
    const { client, t3 } = harness();
    expect(await client.createProject({ name: " Legal AI ", cwd: "/Users/me/legal-ai" })).toEqual({ id: "project-2", name: "Legal AI", cwd: "/Users/me/legal-ai" });
    expect(t3.calls.at(-1)?.args).toEqual({ title: "Legal AI", workspaceRoot: "/Users/me/legal-ai", createWorkspaceRootIfMissing: false });
    expect(await client.createProject({ name: "Fresh" })).toMatchObject({ name: "Fresh", cwd: "/t3-projects/Fresh" });
    expect(t3.calls.at(-1)?.args).toEqual({ title: "Fresh" });
    await expect(client.createProject({ name: "Dup", cwd: "/repo" })).rejects.toThrow("T3 拒绝了请求");
    await expect(client.createProject({ name: "Rel", cwd: "relative/dir" })).rejects.toThrow("绝对路径");
  });

  test("launches into the task worktree with a stable request key and a local thread link", async () => {
    const { client, launches } = harness({ projects: [{ ...project, defaultModelSelection: selection }] });
    const started = await client.start(startInput);
    expect(started).toEqual({ threadId: "thread-u-brain-todo-start-req-1", threadUrl: `${baseUrl}local-env/thread-u-brain-todo-start-req-1` });
    expect(launches()).toHaveLength(1);
    expect(launches()[0]?.args).toMatchObject({
      projectId: project.id, title: "Implement", message: "Do the task", modelSelection: selection, runtimeMode: "auto",
      interactionMode: "default", clientRequestId: "u-brain-todo-start-req-1",
      workspaceStrategy: { type: "existing_worktree", worktreePath: "/worktrees/new", branch: "todo/new" },
    });
  });

  test("recovers a thread already launched for this task worktree instead of launching again", async () => {
    const existing = fakeThread({ threadId: "launched", title: "Implement", worktreePath: "/worktrees/new", status: "running" });
    const { client, launches } = harness({ threads: [existing, fakeThread({ threadId: "other", title: "Implement", worktreePath: "/elsewhere" })] });
    expect((await client.start(startInput)).threadId).toBe("launched");
    expect(launches()).toHaveLength(0);
  });

  test("uploads exact image bytes and launches with a native T3 attachment only once", async () => {
    const { client, t3, launches } = harness({ projects: [{ ...project, defaultModelSelection: selection }] });
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const metadata = { name: "Screenshot.png", mimeType: "image/png" as const, sizeBytes: bytes.length };
    const input = { ...startInput, images: [{ id: "local-image", ...metadata, bytes }] };
    expect(await client.start(input)).toEqual(await client.start(input));
    expect(t3.calls.find((call) => call.name === "t3_attachment_prepare_upload")?.args).toEqual({ upload: { type: "image", ...metadata } });
    expect(t3.uploads).toEqual([{ contentType: "image/png", bytes }]);
    expect(launches()).toHaveLength(1);
    expect(launches()[0]?.args.attachments).toEqual([{ id: "uploaded-image", type: "image", ...metadata }]);
  });

  test("does not launch without the image if upload fails or offers a different origin", async () => {
    const { client, t3, launches } = harness({ projects: [{ ...project, defaultModelSelection: selection }] });
    const input = { ...startInput, images: [{ id: "local-image", name: "Screenshot.png", mimeType: "image/png" as const, sizeBytes: 1, bytes: new Uint8Array([1]) }] };
    t3.state.uploadUrl = "//elsewhere.invalid/signed-upload";
    await expect(client.start(input)).rejects.toThrow("T3 接口返回格式不兼容");
    expect(t3.uploads).toHaveLength(0);
    t3.state.uploadUrl = "/signed-upload";
    t3.state.uploadStatus = 500;
    await expect(client.start(input)).rejects.toThrow("TODO 图片未能上传到 T3");
    expect(launches()).toHaveLength(0);
  });

  test("starts a manual project TODO in plan mode in the owned worktree", async () => {
    const { client, launches } = harness();
    await client.start({ ...startInput, plan: true });
    expect(launches()[0]?.args).toMatchObject({
      projectId: project.id, interactionMode: "plan",
      workspaceStrategy: { type: "existing_worktree", worktreePath: "/worktrees/new", branch: "todo/new" },
    });
    expect(launches()[0]?.args).not.toHaveProperty("modelSelection");
  });

  test("reuses the existing home folder without a worktree and recovers by dispatch reference, not title alone", async () => {
    const { client, t3, launches } = harness();
    const homeTask = { ...startInput, projectId: null, branch: null, cwd: "/Users/hong", plan: true } as const;
    const first = await client.start(homeTask);
    expect(t3.calls.filter((call) => call.name === "t3_project_create").map((call) => call.args)).toEqual([
      { title: "hong", workspaceRoot: "/Users/hong", createWorkspaceRootIfMissing: false },
    ]);
    expect(launches()[0]?.args).toMatchObject({ projectId: "project-2", interactionMode: "plan", workspaceStrategy: { type: "root" } });
    expect(launches()[0]?.args).not.toHaveProperty("modelSelection");
    const second = await client.start({ ...homeTask, requestId: "other-todo" });
    expect(second.threadId).not.toBe(first.threadId);
    const resumed = new T3Automation({ getUrl: async () => baseUrl, getToken: async () => t3.token, fetch: t3.fetch });
    expect(await resumed.start(homeTask)).toEqual(first);
    expect(launches()).toHaveLength(2);
    expect(t3.calls.filter((call) => call.name === "t3_project_create")).toHaveLength(1);
  });

  test("manual TODO waits in plan mode or after changing mode without starting a new turn", async () => {
    const { client, t3 } = harness({ threads: [fakeThread({ interactionMode: "plan" })] });
    const thread = t3.threads[0]!;
    expect((await client.inspect(thread.threadId, true)).state).toBe("planning");
    thread.interactionMode = "default";
    expect((await client.inspect(thread.threadId, true)).state).toBe("planning");
    await client.followup(thread.threadId, "需求和计划已确认，开始执行", "user-confirmed");
    expect((await client.inspect(thread.threadId, true)).state).toBe("running");
    t3.complete(thread.threadId, "已按计划完成");
    expect(await client.inspect(thread.threadId, true)).toEqual({ state: "ready", summary: "已按计划完成" });
  });

  test("new tasks inherit the latest project model and permission mode, default to auto without history", async () => {
    for (const [threads, expected] of [
      [[fakeThread({ threadId: "latest", runtimeMode: "auto-accept-edits", title: "x" }), fakeThread({ threadId: "older", runtimeMode: "full-access", title: "y" })], "auto-accept-edits"],
      [[fakeThread({ threadId: "other-project", projectId: "other", runtimeMode: "full-access" })], "auto"],
      [[fakeThread({ threadId: "unknown-mode", runtimeMode: "unsupported", title: "x" })], "auto"],
    ] as const) {
      const { client, launches } = harness({ projects: [{ ...project, defaultModelSelection: selection }], threads: [...threads] });
      await client.start(startInput);
      expect(launches()[0]?.args).toMatchObject({ runtimeMode: expected });
    }
    const inherited = harness({ threads: [fakeThread({ title: "x", providerInstanceId: "claude", model: "opus" })] });
    await inherited.client.start(startInput);
    expect(inherited.launches()[0]?.args).toMatchObject({ modelSelection: { instanceId: "claude", model: "opus" } });
  });

  test("requires a configured project model rather than inventing a default", async () => {
    await expect(harness().client.start(startInput)).rejects.toThrow("选择模型");
  });

  test("only a completed latest run with its own answer is ready", async () => {
    const cases: Array<[Partial<FakeThread>, "ready" | "running" | "failed"]> = [
      [{}, "ready"],
      [{ status: "running", activeRunId: "run-1" }, "running"],
      [{ status: "waiting" }, "running"],
      [{ pendingRequestCount: 1 }, "running"],
      [{ items: [{ type: "user_message", runId: "run-1", text: "Do it" }] }, "running"],
      [{ items: [{ type: "assistant_message", runId: "run-1", text: "old" }, { type: "user_message", runId: "run-2", text: "again" }] }, "running"],
      [{ latestRunId: "run-2" }, "running"],
    ];
    for (const [overrides, expected] of cases) {
      const { client } = harness({ threads: [fakeThread(overrides)] });
      expect((await client.inspect("task-thread")).state).toBe(expected);
    }
    expect((await harness({ threads: [fakeThread()] }).client.inspect("task-thread")).summary).toBe("Implemented and tested.");
  });

  test("failure, interruption, archive and deletion cannot be accepted for review", async () => {
    for (const [overrides, message] of [
      [{ status: "failed" }, "执行失败"],
      [{ status: "interrupted" }, "已中断"],
      [{ status: "cancelled" }, "已中断"],
      [{ archived: true }, "已删除或归档"],
    ] as const) {
      const result = await harness({ threads: [fakeThread(overrides)] }).client.inspect("task-thread");
      expect(result.state).toBe("failed");
      expect(result.error).toContain(message);
    }
    expect(await harness().client.inspect("missing")).toMatchObject({ state: "failed", error: expect.stringContaining("已删除或归档") });
  });

  test("rework is queued with a stable request key and refused while the thread is busy", async () => {
    const { client, sends } = harness({ threads: [fakeThread()] });
    await client.followup("task-thread", "Fix the issue", "feedback-1");
    expect(sends()[0]?.args).toEqual({ threadId: "task-thread", message: "Fix the issue", mode: "queue", clientRequestId: "u-brain-todo-feedback-feedback-1" });
    const busy = harness({ threads: [fakeThread({ status: "running", activeRunId: "run-1" })] });
    await expect(busy.client.followup("task-thread", "Fix", "feedback-2")).rejects.toThrow("仍在执行");
  });

  test("an already delivered rework is not sent twice, a failed one is sent again", async () => {
    const delivered = fakeThread({ status: "running", activeRunId: "run-2", latestRunId: "run-2", items: [{ type: "user_message", runId: "run-2", text: "Fix it" }] });
    const recovered = harness({ threads: [delivered] });
    await recovered.client.followup("task-thread", "Fix it", "feedback-1");
    expect(recovered.sends()).toHaveLength(0);
    const failed = harness({ threads: [fakeThread({ status: "failed", items: [{ type: "user_message", runId: "run-1", text: "Fix it" }] })] });
    await failed.client.followup("task-thread", "Fix it", "feedback-2");
    expect(failed.sends()).toHaveLength(1);
  });

  test("surfaces T3 refusals, rejects unsupported responses and withholds unauthenticated contents", async () => {
    const refused = harness();
    refused.t3.state.toolFailure = { code: "invalid_request", message: "worktreePath must be one of the project's git worktrees." };
    await expect(refused.client.projects()).rejects.toThrow("T3 拒绝了请求：worktreePath");
    const invalid = harness();
    invalid.t3.state.invalid = true;
    await expect(invalid.client.projects()).rejects.toThrow("格式不兼容");
    const t3 = fakeT3({ projects: [project] });
    const unauthorized = new T3Automation({ getUrl: async () => baseUrl, getToken: async () => "wrong-token", fetch: t3.fetch });
    await expect(unauthorized.projects()).rejects.toThrow("T3 未授权");
  });

  test("rejects nonlocal endpoints before requesting a credential or fetching", async () => {
    let accessed = false;
    const client = new T3Automation({ getUrl: async () => "https://remote.example/", getToken: async () => { accessed = true; return "synthetic"; } });
    await expect(client.projects()).rejects.toThrow("本机");
    expect(accessed).toBe(false);
  });

  test("exchanges one CLI pairing code for an MCP credential, shares it, and revokes it on close", async () => {
    const t3 = fakeT3({ projects: [project], token: "issued-mcp-token" });
    const cli: string[][] = [];
    const oauth: string[] = [];
    let pairingLabel = "";
    let challenge = "";
    const client = new T3Automation({
      getUrl: async () => baseUrl,
      runCli: async (args) => {
        cli.push(args);
        if (args[1] === "pairing") { pairingLabel = args[args.indexOf("--label") + 1]!; return JSON.stringify({ id: "p", credential: "PAIRCODE" }); }
        if (args[2] === "list") return JSON.stringify([
          { sessionId: "stale", client: { label: "U-Brain TODO" } },
          { sessionId: "current", client: { label: pairingLabel } },
          { sessionId: "unrelated", client: { label: "Browser" } },
        ]);
        return "";
      },
      fetch: (async (value: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(value));
        if (!url.pathname.startsWith("/oauth/")) return t3.fetch(value, init);
        oauth.push(url.pathname);
        if (url.pathname === "/oauth/mcp/register") return Response.json({ client_id: "client-1" }, { status: 201 });
        if (url.pathname === "/oauth/mcp/decision") {
          const body = JSON.parse(String(init?.body)) as { authorization: { state: string; code_challenge: string }; decision: unknown };
          expect(body.decision).toEqual({ _tag: "pairing-code", access: "full-access", code: "PAIRCODE" });
          challenge = body.authorization.code_challenge;
          return Response.json({ redirectTo: `http://127.0.0.1/u-brain-todo?code=auth-code&state=${body.authorization.state}` });
        }
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("code")).toBe("auth-code");
        expect(new Bun.CryptoHasher("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(challenge);
        return Response.json({ access_token: "issued-mcp-token", token_type: "Bearer", expires_in: 2_592_000, scope: "orchestration:read" });
      }) as typeof fetch,
    });
    await Promise.all([client.projects(), client.projects()]);
    expect(oauth).toEqual(["/oauth/mcp/register", "/oauth/mcp/decision", "/oauth/mcp/token"]);
    expect(cli.filter((args) => args[1] === "pairing")).toHaveLength(1);
    expect(cli).toContainEqual(["auth", "session", "revoke", "stale"]);
    expect(cli).not.toContainEqual(["auth", "session", "revoke", "unrelated"]);
    await client.close();
    expect(cli.at(-1)).toEqual(["auth", "session", "revoke", "current"]);
  });
});

describe("T3 adapter for phone notices", () => {
  test("lists thread states across projects, reads the latest answer and queues a message", async () => {
    const { client, sends } = harness({ threads: [fakeThread({ threadId: "a", title: "Alpha", status: "running", latestRunId: "run-1" })] });
    expect(await client.threadStates()).toEqual([
      { threadId: "a", title: "Alpha", status: "running", latestRunId: "run-1", snoozed: false, link: "https://app.t3.codes/threads/env/a" },
    ]);
    expect(await client.latestAnswer("a")).toBe("Implemented and tested.");
    expect(await client.sendMessage("a", "继续", "c-1")).toBe("started");
    expect(sends().at(-1)?.args).toEqual({ threadId: "a", message: "继续", mode: "queue", clientRequestId: "u-brain-telegram-c-1" });
  });
});
