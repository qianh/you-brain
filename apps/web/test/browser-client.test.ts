import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createBrowserDaemon } from "../src/api/client.js";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "http://127.0.0.1:4802" } },
  });
});

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("daemon requests with a crowded loopback cookie jar", () => {
  test("TODO review encodes the task id and approval submits the reviewed commit", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const client = createBrowserDaemon({
      token: "synthetic-test-token",
      fetch: (async (input, init) => {
        calls.push({ input: String(input), init: init ?? {} });
        return Response.json({ projects: [], tasks: [], connectionError: null });
      }) as typeof fetch,
    });
    await client.taskReview("task /?&");
    await client.taskAction({ action: "approve", id: "task /?&", reviewSha: "a".repeat(40) });
    const review = new URL(calls[0]!.input, "http://127.0.0.1:4802");
    expect(review.pathname).toBe("/api/tasks/review");
    expect(review.searchParams.get("id")).toBe("task /?&");
    expect(calls[1]?.input).toBe("/api/tasks/action");
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ action: "approve", id: "task /?&", reviewSha: "a".repeat(40) });
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe("Bearer synthetic-test-token");
    expect(calls[1]?.init.credentials).toBe("omit");
  });
  test("checks T3 through the authenticated daemon with an encoded server address", async () => {
    let capturedUrl: string | undefined;
    let captured: RequestInit | undefined;
    const url = "http://[::1]:3773/";
    const client = createBrowserDaemon({
      token: "synthetic-test-token",
      fetch: (async (input, init) => {
        capturedUrl = String(input);
        captured = init;
        return Response.json({ state: "ready", url });
      }) as typeof fetch,
    });
    expect(await client.deckT3(url)).toEqual({ state: "ready", url });
    const target = new URL(capturedUrl!, "http://127.0.0.1:4802");
    expect(target.pathname).toBe("/api/deck/t3");
    expect(target.searchParams.get("url")).toBe(url);
    expect(captured?.method).toBe("GET");
    expect(captured?.credentials).toBe("omit");
    expect(new Headers(captured?.headers).get("authorization")).toBe("Bearer synthetic-test-token");
  });

  test("session deletion sends only the selected pane to the authenticated daemon", async () => {
    let capturedUrl: string | undefined;
    let captured: RequestInit | undefined;
    const client = createBrowserDaemon({
      token: "synthetic-test-token",
      fetch: (async (input, init) => {
        capturedUrl = String(input);
        captured = init;
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    expect(await client.deckTty7Delete(12)).toEqual({ ok: true });
    expect(capturedUrl).toEndWith("/api/deck/tty7/delete");
    expect(captured?.method).toBe("POST");
    expect(captured?.body).toBe(JSON.stringify({ pane: 12 }));
    expect(captured?.credentials).toBe("omit");
    expect(new Headers(captured?.headers).get("authorization")).toBe("Bearer synthetic-test-token");
  });

  test("session rename posts the pane and name to the daemon", async () => {
    let capturedUrl: string | undefined;
    let captured: RequestInit | undefined;
    const client = createBrowserDaemon({
      token: "synthetic-test-token",
      fetch: (async (input, init) => {
        capturedUrl = String(input);
        captured = init;
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    expect(await client.deckTty7Rename(7, "账本")).toEqual({ ok: true });
    expect(capturedUrl).toEndWith("/api/deck/tty7/rename");
    expect(captured?.method).toBe("POST");
    expect(captured?.body).toBe(JSON.stringify({ pane: 7, name: "账本" }));
  });

  test("deck notices fetch, dismiss, and bounded screen preview hit authenticated routes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createBrowserDaemon({
      token: "synthetic-test-token",
      fetch: (async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return Response.json({ ok: true, epoch: "e1", latest: 0, notices: [], pane: 7, text: "" });
      }) as typeof fetch,
    });
    await client.deckNotices();
    await client.deckNoticeDismiss({ seq: 3 });
    await client.deckTty7Screen(7, 10);
    expect(calls[0]?.url).toBe("/api/deck/notices");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[1]?.url).toBe("/api/deck/notices/dismiss");
    expect(calls[1]?.init.method).toBe("POST");
    expect(calls[1]?.init.body).toBe(JSON.stringify({ seq: 3 }));
    expect(calls[2]?.url).toBe("/api/deck/tty7/screen?pane=7&lines=10");
  });

  test("API calls omit cookies while retaining Bearer auth and request bodies", async () => {
    const calls: RequestInit[] = [];
    const client = createBrowserDaemon({
      token: "synthetic-test-token",
      fetch: (async (_input, init) => {
        calls.push(init ?? {});
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    const image = new Blob(["synthetic image"], { type: "image/png" });

    await client.status();
    await client.deckTty7Send({ pane: 7, text: "hello", enter: true });
    await client.deckTty7PasteImage(image);

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.credentials).toBe("omit");
      expect(new Headers(call.headers).get("authorization")).toBe("Bearer synthetic-test-token");
    }
    expect(calls[1]?.body).toBe(JSON.stringify({ pane: 7, text: "hello", enter: true }));
    expect(calls[2]?.body).toBe(image);
  });

  test("SSE omits cookies and still delivers authenticated events", async () => {
    let captured: RequestInit | undefined;
    const client = createBrowserDaemon({
      token: "synthetic-test-token",
      fetch: (async (_input, init) => {
        captured = init;
        return new Response('data: {"id":1,"kind":"ready","at":"2026-11-14T00:00:00Z"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch,
    });
    const events: unknown[] = [];
    await client.events((event) => events.push(event));

    expect(captured?.credentials).toBe("omit");
    expect(new Headers(captured?.headers).get("authorization")).toBe("Bearer synthetic-test-token");
    expect(events).toEqual([{ id: 1, kind: "ready", at: "2026-11-14T00:00:00Z" }]);
  });

  test("portrait project filter and coding proposal review hit authenticated routes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createBrowserDaemon({
      token: "synthetic-test-token",
      fetch: (async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return Response.json({ ok: true, proposals: [], version: "v11", variant: "projects", content: "", path: "", updatedAt: null });
      }) as typeof fetch,
    });
    await client.portrait("projects", "you-brain");
    await client.portraitProposals();
    await client.reviewPortraitProposal({ id: "prop-1", action: "approve", editedLine: "- **规则**：示例" });
    expect(calls[0]?.url).toBe("/api/portrait?variant=projects&project=you-brain");
    expect(calls[1]?.url).toBe("/api/portrait/proposals");
    expect(calls[1]?.init.method).toBe("GET");
    expect(calls[2]?.url).toBe("/api/portrait/proposals");
    expect(calls[2]?.init.method).toBe("POST");
    expect(JSON.parse(calls[2]!.init.body as string)).toEqual({
      id: "prop-1",
      action: "approve",
      editedLine: "- **规则**：示例",
    });
  });

  test("reference candidates, content, and materialize hit authenticated routes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createBrowserDaemon({
      token: "synthetic-test-token",
      fetch: (async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return Response.json({ ok: true, candidates: [], path: "/tmp/ref.md", fileMention: "@/tmp/ref.md" });
      }) as typeof fetch,
    });
    await client.referenceCandidates({ query: "合同", kinds: ["kb", "topic"], limit: 5 });
    await client.referenceContent({ uri: "u-brain-kb:abc", label: "合同" });
    await client.materializeReference({ uri: "u-brain-kb:abc", label: "合同" });

    expect(calls[0]?.url).toBe("/api/references/candidates?q=%E5%90%88%E5%90%8C&kinds=kb%2Ctopic&limit=5");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[1]?.url).toBe("/api/references/content?uri=u-brain-kb%3Aabc&label=%E5%90%88%E5%90%8C");
    expect(calls[1]?.init.method).toBe("GET");
    expect(calls[2]?.url).toBe("/api/references/materialize");
    expect(calls[2]?.init.method).toBe("POST");
    expect(JSON.parse(calls[2]!.init.body as string)).toEqual({ uri: "u-brain-kb:abc", label: "合同" });
  });
});
