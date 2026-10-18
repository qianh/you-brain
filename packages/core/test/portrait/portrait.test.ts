import { lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { CLAUDE_CODING_PORTRAIT_LINE } from "../../src/clients/catalog.js";
import { YouBrainError } from "../../src/domain/errors.js";
import { platformPaths } from "../../src/domain/paths.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import {
  FilePortraitConsentStore,
  PortraitService,
  decodePortraitMeta,
  type PortraitConfig,
  type PortraitStore,
} from "../../src/portrait/index.js";
import { SqliteStore } from "../../src/store/index.js";
import type { PortraitRecord } from "../../src/store/types.js";

const FULL = "digital-twin/JOHN-DIGITAL-TWIN-latest.md";
const BRIEF = "digital-twin/JOHN-DIGITAL-TWIN-latest-brief.md";
const CODING = "digital-twin/JOHN-TWIN-coding.md";

function config(codingPath = CODING): PortraitConfig {
  return {
    variants: [
      { id: "full", path: `/brain-hub/${FULL}` },
      { id: "brief", path: BRIEF },
      { id: "coding", path: codingPath.startsWith("/") ? codingPath : `/${codingPath}` },
    ],
    snapshotPattern: "/brain-hub/digital-twin/JOHN-DIGITAL-TWIN-v*-*.md",
  };
}

function countingStore(store: SqliteStore): PortraitStore & { writes: number } {
  let writes = 0;
  return {
    get writes() {
      return writes;
    },
    getPortrait(variant: string) {
      return store.getPortrait(variant);
    },
    upsertPortrait(record: PortraitRecord) {
      writes += 1;
      store.upsertPortrait(record);
    },
  };
}

async function fixture(): Promise<{
  home: string;
  drive: MemoryDrive;
  store: SqliteStore;
  tracked: ReturnType<typeof countingStore>;
  service: PortraitService;
  consent: FilePortraitConsentStore;
}> {
  const home = await mkdtemp(join(tmpdir(), "you-brain-portrait-"));
  const paths = platformPaths({ platform: "darwin", homeDir: home, env: {} });
  let tick = Date.parse("2026-01-01T00:00:00.000Z");
  const drive = new MemoryDrive({
    now: () => {
      const current = new Date(tick);
      tick += 86_400_000;
      return current;
    },
  });
  const store = new SqliteStore(join(paths.dataDir, "state.sqlite"));
  const tracked = countingStore(store);
  const consent = new FilePortraitConsentStore(join(paths.dataDir, "portrait-consent.json"));
  const service = new PortraitService({
    drive,
    store: tracked,
    paths,
    config: config(),
    driveRoot: "brain-hub",
    consent,
    homeDir: home,
    managedStatePath: join(paths.dataDir, "managed-blocks.json"),
  });
  return { home, drive, store, tracked, service, consent };
}

async function cleanup(home: string, store: SqliteStore): Promise<void> {
  store.close();
  await rm(home, { recursive: true, force: true });
}

describe("portrait pull", () => {
  it("pulls absolute and root-relative variants, then skips unchanged bytes", async () => {
    const { home, drive, store, tracked, service } = await fixture();
    try {
      const full = await drive.put({
        path: FULL,
        bytes: Buffer.from("# 全量\n", "utf8"),
        mimeType: "text/markdown",
      });
      const brief = await drive.put({
        path: BRIEF,
        bytes: Buffer.from("# 精简\n", "utf8"),
        mimeType: "text/markdown",
      });
      await drive.put({
        path: CODING,
        bytes: Buffer.from("# 编码\n", "utf8"),
        mimeType: "text/markdown",
      });
      const first = await service.pull();
      expect(first.variants.map((item) => item.status)).toEqual(["written", "written", "written"]);
      expect(tracked.writes).toBe(3);
      const fullPath = first.variants[0]?.localPath ?? "";
      expect(fullPath.endsWith("/portrait/full.md")).toBe(true);
      expect(await readFile(fullPath, "utf8")).toBe("# 全量\n");
      expect((await lstat(fullPath)).mode & 0o777).toBe(0o600);
      const names = await readdir(join(fullPath, ".."));
      expect(names.filter((name) => name.includes(".tmp"))).toEqual([]);

      const row = store.getPortrait("full");
      const meta = decodePortraitMeta(row?.version ?? "");
      expect(row?.path).toBe(fullPath);
      expect(row?.updatedAt).toBe(full.modifiedTime);
      expect(meta).toEqual({ etag: full.etag, md5: full.md5Checksum, drivePath: FULL });
      expect(decodePortraitMeta(store.getPortrait("brief")?.version ?? "")?.md5).toBe(
        brief.md5Checksum,
      );

      const old = new Date("2020-01-01T00:00:00.000Z");
      await utimes(fullPath, old, old);
      const second = await service.pull();
      expect(second.variants.map((item) => item.status)).toEqual(["skipped", "skipped", "skipped"]);
      expect(tracked.writes).toBe(3);
      expect((await stat(fullPath)).mtimeMs).toBeLessThan(Date.parse("2021-01-01T00:00:00.000Z"));

      await drive.update(full.id, "# 全量\n");
      const metadata = await service.pull();
      expect(metadata.variants[0]?.status).toBe("skipped");
      expect(tracked.writes).toBe(4);
      expect((await stat(fullPath)).mtimeMs).toBeLessThan(Date.parse("2021-01-01T00:00:00.000Z"));
      expect(store.getPortrait("full")?.updatedAt).not.toBe(full.modifiedTime);
      expect(decodePortraitMeta(store.getPortrait("full")?.version ?? "")?.md5).toBe(
        full.md5Checksum,
      );

      await drive.update(full.id, "# 全量 v2\n");
      const third = await service.pull();
      expect(third.variants[0]?.status).toBe("written");
      expect(await readFile(fullPath, "utf8")).toBe("# 全量 v2\n");
      expect((await stat(fullPath)).mtimeMs).toBeGreaterThan(Date.parse("2024-01-01T00:00:00.000Z"));

      await rm(fullPath);
      const restored = await service.pull();
      expect(restored.variants[0]?.status).toBe("written");
      expect(await readFile(fullPath, "utf8")).toBe("# 全量 v2\n");
    } finally {
      await cleanup(home, store);
    }
  });

  it("lists snapshot files for the configured glob and ignores other names", async () => {
    const { home, drive, store, service } = await fixture();
    try {
      await drive.put({
        path: "digital-twin/JOHN-DIGITAL-TWIN-v1-2024-01-01.md",
        bytes: Buffer.from("v1"),
        mimeType: "text/markdown",
      });
      await drive.put({
        path: FULL,
        bytes: Buffer.from("latest"),
        mimeType: "text/markdown",
      });
      await drive.put({
        path: "digital-twin/notes.md",
        bytes: Buffer.from("nope"),
        mimeType: "text/markdown",
      });
      await drive.put({
        path: "digital-twin/nested/JOHN-DIGITAL-TWIN-v9-2024-01-01.md",
        bytes: Buffer.from("nested"),
        mimeType: "text/markdown",
      });
      const newer = await drive.put({
        path: "digital-twin/JOHN-DIGITAL-TWIN-v2-2025-06-01.md",
        bytes: Buffer.from("v2"),
        mimeType: "text/markdown",
      });
      const snapshots = await service.listSnapshots();
      expect(snapshots.map((item) => item.name)).toEqual([
        "JOHN-DIGITAL-TWIN-v2-2025-06-01.md",
        "JOHN-DIGITAL-TWIN-v1-2024-01-01.md",
      ]);
      expect(snapshots[0]?.fileId).toBe(newer.id);
      expect(snapshots[0]?.md5).toBe(newer.md5Checksum);
      expect(snapshots[0]?.path).toBe("digital-twin/JOHN-DIGITAL-TWIN-v2-2025-06-01.md");
    } finally {
      await cleanup(home, store);
    }
  });

  it("reads the local full variant and fetches from Drive only when it is missing", async () => {
    const { home, drive, store, service } = await fixture();
    try {
      await drive.put({
        path: FULL,
        bytes: Buffer.from("# 全量\n", "utf8"),
        mimeType: "text/markdown",
      });
      await drive.put({
        path: BRIEF,
        bytes: Buffer.from("# 精简\n", "utf8"),
        mimeType: "text/markdown",
      });
      await service.pull();
      await drive.update(
        (await drive.findByPath(FULL))?.id ?? "",
        "# 云端新版\n",
      );
      const local = await service.getPortrait();
      expect(local.variant).toBe("full");
      expect(local.portrait).toBe("# 全量\n");
      await rm(local.path);
      const fetched = await service.getPortrait("full");
      expect(fetched.portrait).toBe("# 云端新版\n");
      expect(await service.getPortrait("brief")).toMatchObject({ portrait: "# 精简\n" });
      await expect(service.getPortrait("missing")).rejects.toThrow(YouBrainError);
    } finally {
      await cleanup(home, store);
    }
  });

  it("rejects a portrait path that escapes the Drive root", async () => {
    const { home, store, service } = await fixture();
    try {
      service.setConfig({
        variants: [{ id: "full", path: "../secret.md" }],
        snapshotPattern: "digital-twin/*.md",
      });
      await expect(service.pull()).rejects.toThrow(YouBrainError);
    } finally {
      await cleanup(home, store);
    }
  });

  it("reapplies consented CLI blocks when the coding path or wording fingerprint changes", async () => {
    const { home, store, service, consent } = await fixture();
    try {
      await mkdir(join(home, ".claude"));
      const claude = join(home, ".claude", "CLAUDE.md");
      const applied = await service.applyConsented(["claude-code:portrait", "not-a-client"]);
      expect(applied.applied).toEqual(["claude-code:portrait"]);
      expect(await readFile(claude, "utf8")).toContain(CLAUDE_CODING_PORTRAIT_LINE);
      const saved = await consent.load();
      expect(saved.itemIds).toEqual(["claude-code:portrait"]);
      expect(saved.fingerprint).toContain(CODING);

      await writeFile(
        claude,
        `# mine\n\n<!-- you-brain:start v1 -->\ntampered\n<!-- you-brain:end -->\n`,
      );
      const idle = await service.reconcileCodingInjection();
      expect(idle.updated).toBe(false);
      expect(await readFile(claude, "utf8")).toContain("tampered");

      const nextCoding = "/digital-twin/JOHN-TWIN-coding-v2.md";
      service.setConfig(config(nextCoding));
      const pulled = await service.pull();
      expect(pulled.injection.updated).toBe(true);
      expect(pulled.injection.applied).toContain("claude-code:portrait");
      const restored = await readFile(claude, "utf8");
      expect(restored).toContain("# mine");
      expect(restored).toContain(CLAUDE_CODING_PORTRAIT_LINE);
      expect(restored).not.toContain("tampered");
      expect((await consent.load()).fingerprint).toContain("JOHN-TWIN-coding-v2.md");

      const again = new PortraitService({
        drive: new MemoryDrive(),
        store,
        paths: platformPaths({ platform: "darwin", homeDir: home, env: {} }),
        config: config(nextCoding),
        driveRoot: "brain-hub",
        consent,
        homeDir: home,
        managedStatePath: join(
          platformPaths({ platform: "darwin", homeDir: home, env: {} }).dataDir,
          "managed-blocks.json",
        ),
      });
      expect((await again.reconcileCodingInjection()).updated).toBe(false);
    } finally {
      await cleanup(home, store);
    }
  });

  it("does not inject until a fingerprint exists, and treats a stale fingerprint as a wording change", async () => {
    const { home, store, service, consent } = await fixture();
    try {
      await mkdir(join(home, ".claude"));
      const claude = join(home, ".claude", "CLAUDE.md");
      await consent.save({ itemIds: ["claude-code:portrait"], fingerprint: null });
      expect((await service.reconcileCodingInjection()).updated).toBe(false);
      await expect(stat(claude)).rejects.toThrow();

      await consent.save({ itemIds: ["claude-code:portrait"], fingerprint: "stale-wording" });
      const updated = await service.reconcileCodingInjection();
      expect(updated.updated).toBe(true);
      expect(await readFile(claude, "utf8")).toContain(CLAUDE_CODING_PORTRAIT_LINE);
      expect((await consent.load()).fingerprint).not.toBe("stale-wording");
    } finally {
      await cleanup(home, store);
    }
  });
});
