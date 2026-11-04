import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { HttpDeps } from "../../src/http/deps.js";
import { startDaemonHttp } from "../../src/http/server.js";
import { createDaemonClient } from "../../src/http/client.js";
import type { SearchSettings } from "../../src/http/types.js";

describe("search provider routes", () => {
  it("reads settings, saves a key, and only enables a provider that has a key", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ub-search-http-"));
    const keys = new Set<string>();
    let active: SearchSettings["active"] = null;
    const settings = (): SearchSettings => ({
      active,
      providers: { exa: { hasKey: keys.has("exa") }, tavily: { hasKey: keys.has("tavily") } },
    });
    const deps = {
      searchSettings: async () => settings(),
      writeSearchKey: async (body: { provider: string }) => void keys.add(body.provider),
      writeSearchActive: async (body: { active: SearchSettings["active"] }) => {
        if (body.active !== null && !keys.has(body.active)) throw new Error("no key");
        active = body.active;
      },
      events: { emit() {} },
    } as unknown as HttpDeps;
    const server = await startDaemonHttp({ dataDir, deps });
    try {
      const client = createDaemonClient({ port: server.port, token: server.token });
      expect(await client.searchSettings()).toEqual(settings());
      await client.putSearchKey({ provider: "exa", apiKey: "k" });
      expect((await client.searchSettings()).providers.exa.hasKey).toBe(true);
      const on = await client.putSearchActive({ active: "exa" });
      expect(on.active).toBe("exa");
      expect((await client.putSearchActive({ active: null })).active).toBeNull();
      const bad = await fetch(`${server.baseUrl}/api/search-provider`, {
        method: "PUT",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ active: "bing" }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await server.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
