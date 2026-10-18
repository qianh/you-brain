import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { CLAUDE_CODING_PORTRAIT_LINE } from "../../src/clients/catalog.js";
import {
  CodingInjection,
  FilePortraitConsentStore,
  codingInjectionFingerprint,
  grantIntegrationConsent,
  portraitConsentPath,
  revokeIntegrationConsent,
} from "../../src/portrait/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("integration consent", () => {
  it("keeps non-portrait ids and reapplies managed blocks even without a fingerprint", async () => {
    const home = await mkdtemp(join(tmpdir(), "you-brain-consent-"));
    roots.push(home);
    await mkdir(join(home, ".claude"), { recursive: true });
    const dataDir = join(home, "data");
    await mkdir(dataDir, { recursive: true });
    const store = new FilePortraitConsentStore(portraitConsentPath(dataDir));
    const coding = "digital-twin/JOHN-TWIN-coding.md";
    await grantIntegrationConsent(
      store,
      ["claude-code:mcp", "claude-code:portrait", "claude-code:skill:you-brain"],
      coding,
    );
    expect((await store.load()).fingerprint).toBe(codingInjectionFingerprint(coding));

    const claude = join(home, ".claude", "CLAUDE.md");
    const injection = new CodingInjection({
      homeDir: home,
      managedStatePath: join(dataDir, "managed-blocks.json"),
      consent: store,
      codingPath: () => coding,
    });
    await writeFile(claude, "<!-- you-brain:start v1 -->\ntampered\n<!-- you-brain:end -->\n");
    const applied = await injection.ensureApplied();
    expect(applied.updated).toBe(true);
    expect(await readFile(claude, "utf8")).toContain(CLAUDE_CODING_PORTRAIT_LINE);
    expect((await store.load()).itemIds).toEqual([
      "claude-code:mcp",
      "claude-code:skill:you-brain",
      "claude-code:portrait",
    ]);

    await revokeIntegrationConsent(store, ["claude-code:portrait", "claude-code:mcp"]);
    const revoked = await store.load();
    expect(revoked.itemIds).toEqual(["claude-code:skill:you-brain"]);
    expect(revoked.fingerprint).toBeNull();
  });
});
