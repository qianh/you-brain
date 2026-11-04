import { describe, expect, it } from "bun:test";

import { getSearchKey, searchKeychainService, setSearchKey } from "../../src/auth/search-secrets.js";
import { MemorySecretStore } from "../../src/auth/secret-store.js";

describe("search secrets", () => {
  it("stores a trimmed key and reads it back", async () => {
    const store = new MemorySecretStore(null);
    await setSearchKey("exa", "  exa-key \n", { platform: "darwin", store });
    await expect(getSearchKey("exa", { platform: "darwin", store })).resolves.toBe("exa-key");
  });

  it("returns null when nothing is stored and rejects an empty key", async () => {
    const store = new MemorySecretStore(null);
    await expect(getSearchKey("exa", { platform: "darwin", store })).resolves.toBeNull();
    await expect(setSearchKey("exa", "   ", { platform: "darwin", store })).rejects.toThrow(/empty/);
  });

  it("keeps search keys out of the LLM keychain namespace", () => {
    expect(searchKeychainService("exa")).toContain("/search/exa");
    expect(searchKeychainService("exa")).not.toContain("/llm/");
  });
});
