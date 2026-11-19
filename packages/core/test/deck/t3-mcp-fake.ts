/** 按 T3 0.1.9 MCP 工具结构实现的最小测试替身；只覆盖 TODO 适配器用到的工具。 */
export interface FakeItem { type: "user_message" | "assistant_message"; runId: string | null; text: string }

export interface FakeThread {
  threadId: string;
  projectId: string;
  title: string;
  status: string;
  activeRunId: string | null;
  latestRunId: string | null;
  pendingRequestCount: number;
  archived: boolean;
  worktreePath: string | null;
  branch: string | null;
  providerInstanceId: string;
  model: string;
  runtimeMode: string;
  interactionMode: "plan" | "default";
  items: FakeItem[];
}

export interface FakeProject { id: string; title: string; workspaceRoot: string; defaultModelSelection: unknown; deletedAt?: string | null }

export function fakeThread(overrides: Partial<FakeThread> = {}): FakeThread {
  return {
    threadId: "task-thread", projectId: "project-1", title: "Task", status: "completed",
    activeRunId: null, latestRunId: "run-1", pendingRequestCount: 0, archived: false,
    worktreePath: "/worktrees/task", branch: "todo/task", providerInstanceId: "codex", model: "configured-model",
    runtimeMode: "approval-required", interactionMode: "default",
    items: [{ type: "user_message", runId: "run-1", text: "Do it" }, { type: "assistant_message", runId: "run-1", text: "Implemented and tested." }],
    ...overrides,
  };
}

export function fakeT3(input: { projects: FakeProject[]; threads?: FakeThread[]; token?: string; environmentId?: string }) {
  const token = input.token ?? "synthetic-token";
  /** 新的在前，与 t3_thread_list 一致。 */
  const threads: FakeThread[] = [...(input.threads ?? [])];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const state = { initializes: 0, expireSession: false, toolFailure: null as null | { code: string; message: string }, invalid: false };
  let session = 0;
  let runs = 100;

  const find = (threadId: unknown) => threads.find((thread) => thread.threadId === threadId);
  const result = (structuredContent: unknown) => ({ content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent });
  const failure = (code: string, message: string) => ({ content: [{ type: "text", text: JSON.stringify({ _tag: "OrchestratorMcpFailure", code, message }) }], isError: true });
  const summary = (thread: FakeThread) => ({
    threadId: thread.threadId, projectId: thread.projectId, title: thread.title, status: thread.status,
    latestRunId: thread.latestRunId, providerInstanceId: thread.providerInstanceId, model: thread.model, runtimeMode: thread.runtimeMode,
  });

  function tool(name: string, args: Record<string, unknown>): unknown {
    calls.push({ name, args });
    if (state.toolFailure) return failure(state.toolFailure.code, state.toolFailure.message);
    if (state.invalid) return result({ unexpected: true });
    if (name === "t3_project_list") return result({ projects: input.projects, nextCursor: null });
    if (name === "t3_project_create") {
      const root = typeof args.workspaceRoot === "string" ? args.workspaceRoot : `/t3-projects/${String(args.title)}`;
      if (input.projects.some((project) => project.workspaceRoot === root)) return failure("project_exists", "This folder is already a project.");
      const project: FakeProject = { id: `project-${input.projects.length + 1}`, title: String(args.title), workspaceRoot: root, defaultModelSelection: null };
      input.projects.push(project);
      return result({ ...project, createdAt: "2026-11-16T00:00:00.000Z" });
    }
    if (name === "t3_thread_list") {
      if (typeof args.projectId !== "string") return failure("target_required", "Pass projectId");
      const filter = typeof args.titleContains === "string" ? args.titleContains : "";
      return result({ projectId: args.projectId, threads: threads.filter((thread) => thread.projectId === args.projectId && thread.title.includes(filter)).map(summary), nextCursor: null });
    }
    if (name === "t3_thread_read") {
      const thread = find(args.threadId);
      if (!thread) return failure("thread_not_found", `Thread ${String(args.threadId)} is no longer available.`);
      const after = typeof args.afterPosition === "number" ? args.afterPosition : -1;
      const limit = typeof args.limit === "number" ? args.limit : 100;
      const items = thread.items.map((item, position) => ({
        position, visibility: "local", sourceThreadId: thread.threadId, itemId: `item-${position}`, runId: item.runId, messageId: `message-${position}`,
        createdBy: item.type === "user_message" ? "user" : "agent", creationSource: "mcp", type: item.type, status: "completed",
        title: null, text: item.text, textTruncated: false, updatedAt: "2026-11-16T00:00:00.000Z",
      })).filter((item) => item.position > after).slice(0, limit);
      const { items: _items, ...rest } = thread;
      return result({ thread: { ...rest, itemCount: thread.items.length }, recentRuns: [], items, nextPosition: null, hasMore: false });
    }
    if (name === "t3_thread_launch") {
      const threadId = `thread-${String(args.clientRequestId)}`;
      if (!find(threadId)) {
        const runId = `run-${++runs}`;
        const strategy = args.workspaceStrategy as { type: string; worktreePath?: string; branch?: string };
        const selection = args.modelSelection as { instanceId: string; model: string } | undefined;
        threads.unshift({
          threadId, projectId: String(args.projectId), title: String(args.title), status: "running", activeRunId: runId, latestRunId: runId,
          pendingRequestCount: 0, archived: false, worktreePath: strategy.worktreePath ?? null, branch: strategy.branch ?? null,
          providerInstanceId: selection?.instanceId ?? "default-provider", model: selection?.model ?? "default-model", runtimeMode: String(args.runtimeMode),
          interactionMode: args.interactionMode === "plan" ? "plan" : "default",
          items: [{ type: "user_message", runId, text: String(args.message) }],
        });
      }
      return result({ threadId, link: `https://app.t3.codes/threads/env/${threadId}`, projectId: args.projectId, modelSelection: args.modelSelection, runId: null, status: "running" });
    }
    if (name === "t3_thread_send") {
      const thread = find(args.threadId);
      if (!thread) return failure("thread_not_found", "missing");
      const runId = `run-${++runs}`;
      thread.items.push({ type: "user_message", runId, text: String(args.message) });
      Object.assign(thread, { status: "running", activeRunId: runId, latestRunId: runId });
      return result({ threadId: thread.threadId, messageId: "m", runId, status: "running", delivery: "started" });
    }
    return failure("unknown_tool", name);
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/t3/environment") return Response.json({ environmentId: input.environmentId ?? "local-env" });
    if (url.pathname !== "/mcp" || request.method !== "POST") return new Response(null, { status: 404 });
    if (request.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ error: "invalid_mcp_credential" }, { status: 401 });
    const body = await request.json() as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
    if (body.method === "initialize") {
      state.initializes++;
      session++;
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "T3 Code", version: "0.1.9" } } },
        { headers: { "mcp-session-id": `session-${session}` } });
    }
    if (request.headers.get("mcp-session-id") !== `session-${session}` || state.expireSession) {
      state.expireSession = false;
      return new Response(null, { status: 404 });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/call") return Response.json({ jsonrpc: "2.0", id: body.id, result: tool(body.params!.name, body.params!.arguments) });
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
  }

  /** 模拟 T3 一轮执行完成并回复。 */
  function complete(threadId: string, text: string): void {
    const thread = find(threadId)!;
    thread.items.push({ type: "assistant_message", runId: thread.latestRunId, text });
    Object.assign(thread, { status: "completed", activeRunId: null });
  }

  const fetchImpl = (async (value: string | URL | Request, init?: RequestInit) => handle(new Request(value instanceof URL ? value.toString() : value as string, init))) as typeof fetch;
  return { threads, calls, state, handle, complete, fetch: fetchImpl, token };
}
