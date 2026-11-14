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
});
