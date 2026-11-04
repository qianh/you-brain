import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { readSearchActive, writeSearchActive } from "../../src/deck/dsh/search-config.js";
// @ts-expect-error 插件是纯 JS 模块（随 App 打包），没有类型声明。
import { createExaProvider, createTavilyProvider } from "../../../../sidecars/dsh-host/plugins/u-brain-search.mjs";

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, calls: FetchCall[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

describe("search selection file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ub-search-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips the active provider and falls back to null (DeepSeek default)", async () => {
    const path = join(dir, "search.json");
    expect(await readSearchActive(path)).toBeNull();
    await writeSearchActive(path, "tavily");
    expect(await readSearchActive(path)).toBe("tavily");
    await writeSearchActive(path, null);
    expect(await readSearchActive(path)).toBeNull();
    await writeFile(path, '{"active":"bing"}');
    expect(await readSearchActive(path)).toBeNull();
    await writeFile(path, "not json");
    expect(await readSearchActive(path)).toBeNull();
  });
});

describe("Exa provider", () => {
  it("is unavailable without a key", () => {
    expect(createExaProvider({ env: {} }).available()).toBe(false);
  });

  it("posts the query with x-api-key and maps highlights, dates and dedupes urls", async () => {
    const calls: FetchCall[] = [];
    const provider = createExaProvider({
      env: { EXA_API_KEY: "k-exa" },
      fetch: fakeFetch(
        200,
        {
          results: [
            { title: "A", url: "https://a.test", publishedDate: "2026-10-01", highlights: ["one", "two"] },
            { title: "A again", url: "https://a.test", text: "dup" },
            { title: "B", url: "https://b.test", text: "body text" },
            { title: "no url" },
          ],
        },
        calls,
      ),
    });
    const result = await provider.search({ query: "q", maxResults: 3 });
    expect(calls[0]?.url).toBe("https://api.exa.ai/search");
    expect((calls[0]?.init.headers as Record<string, string>)["x-api-key"]).toBe("k-exa");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ query: "q", numResults: 3 });
    expect(result.sources).toEqual([
      { url: "https://a.test", title: "A", snippet: "one … two", publishedAt: "2026-10-01" },
      { url: "https://b.test", title: "B", snippet: "body text" },
    ]);
  });

  it("reports HTTP failures without leaking the key", async () => {
    const provider = createExaProvider({ env: { EXA_API_KEY: "secret-key" }, fetch: fakeFetch(401, "bad key") });
    const error = await provider.search({ query: "q" }).catch((cause: unknown) => cause as Error);
    expect(String(error)).toContain("HTTP 401");
    expect(String(error)).not.toContain("secret-key");
  });
});

describe("Tavily provider", () => {
  it("is unavailable without a key", () => {
    expect(createTavilyProvider({ env: { TAVILY_API_KEY: "  " } }).available()).toBe(false);
  });

  it("posts with a bearer token and maps content to snippet", async () => {
    const calls: FetchCall[] = [];
    const provider = createTavilyProvider({
      env: { TAVILY_API_KEY: "tvly-x" },
      fetch: fakeFetch(
        200,
        { results: [{ title: "T", url: "https://t.test", content: "snip", published_date: "2026-11-01" }] },
        calls,
      ),
    });
    const result = await provider.search({ query: "q" });
    expect(calls[0]?.url).toBe("https://api.tavily.com/search");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer tvly-x");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ query: "q", max_results: 8, search_depth: "basic" });
    expect(result.sources).toEqual([{ url: "https://t.test", title: "T", snippet: "snip", publishedAt: "2026-11-01" }]);
  });

  it("turns a caller abort into WEB_ABORTED", async () => {
    const controller = new AbortController();
    const provider = createTavilyProvider({
      env: { TAVILY_API_KEY: "k" },
      fetch: (async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }) as unknown as typeof fetch,
    });
    const error = (await provider.search({ query: "q" }, controller.signal).catch((cause: unknown) => cause)) as { code?: string };
    expect(error.code).toBe("WEB_ABORTED");
  });
});
