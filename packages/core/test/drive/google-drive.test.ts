import { describe, expect, it, mock } from "bun:test";

import { google } from "googleapis";

import { GoogleDrive } from "../../src/drive/google-drive.js";

const folderMimeType = "application/vnd.google-apps.folder";

function createConcurrentDriveClient() {
  interface StoredFile {
    id: string;
    name: string;
    mimeType: string;
    parents: string[];
    size: string;
    modifiedTime: string;
    appProperties: Record<string, string>;
    version: string;
    trashed: boolean;
  }

  const files: StoredFile[] = [];
  let nextId = 0;
  const client = {
    files: {
      list: async (request: { q?: string }) => {
        const parent = /^'([^']+)' in parents/u.exec(request.q ?? "")?.[1];
        return {
          data: {
            files: files
              .filter((file) => file.parents.includes(parent ?? ""))
              .map((file) => ({ ...file })),
          },
        };
      },
      create: async (request: {
        requestBody?: {
          name?: string;
          mimeType?: string;
          parents?: string[];
          appProperties?: Record<string, string>;
        };
        media?: unknown;
      }) => {
        const body = request.requestBody;
        if (!body?.name) throw new Error("missing file name");
        const file: StoredFile = {
          id: `file-${(nextId += 1)}`,
          name: body.name,
          mimeType: body.mimeType ?? "application/octet-stream",
          parents: body.parents ?? [],
          size: request.media ? "1" : "0",
          modifiedTime: "2026-07-20T00:00:00.000Z",
          appProperties: body.appProperties ?? {},
          version: "1",
          trashed: false,
        };
        files.push(file);
        return { data: { ...file } };
      },
    },
  };
  return { client, files };
}

describe("Google Drive boundary", () => {
  it("uses Drive change tokens for incremental inbox refresh", async () => {
    const entries = [
      {
        id: "inbox",
        name: "inbox",
        mimeType: folderMimeType,
        parents: ["root"],
      },
      {
        id: "device",
        name: "mac",
        mimeType: folderMimeType,
        parents: ["inbox"],
      },
      {
        id: "inside",
        name: "session.md",
        mimeType: "text/markdown",
        parents: ["device"],
      },
    ].map((entry) => ({
      ...entry,
      size: "1",
      modifiedTime: "2026-07-26T00:00:00.000Z",
      appProperties: {},
      version: "1",
      trashed: false,
    }));
    const changeTokens: string[] = [];
    const client = {
      files: {
        list: async (request: { q?: string }) => {
          const parent = /^'([^']+)' in parents/u.exec(request.q ?? "")?.[1];
          return {
            data: {
              files: entries.filter((entry) =>
                entry.parents.includes(parent ?? ""),
              ),
            },
          };
        },
        get: async (request: { fileId?: string }) => ({
          data: entries.find((entry) => entry.id === request.fileId),
        }),
      },
      changes: {
        getStartPageToken: async () => ({ data: { startPageToken: "10" } }),
        list: async (request: { pageToken?: string }) => {
          changeTokens.push(request.pageToken ?? "");
          return {
            data: {
              changes: [
                { fileId: "inside", file: entries[2] },
                { fileId: "deleted", removed: true },
              ],
              newStartPageToken: "11",
            },
          };
        },
      },
    };
    const drive = new GoogleDrive({
      client: client as never,
      rootFolderId: "root",
    });

    const initial = await drive.changes({ prefix: "inbox/" });
    const incremental = await drive.changes({
      prefix: "inbox/",
      cursor: initial.cursor,
    });

    expect(initial).toMatchObject({ cursor: "10", reset: true });
    expect(initial.entries.map((entry) => entry.id)).toEqual(["inside"]);
    expect(incremental).toMatchObject({
      cursor: "11",
      reset: false,
      removedIds: ["deleted"],
    });
    expect(incremental.entries.map((entry) => entry.id)).toEqual(["inside"]);
    expect(changeTokens).toEqual(["10"]);
  });

  it("fails an incremental refresh on transient metadata errors", async () => {
    const transient = Object.assign(new Error("rate limited"), { code: 429 });
    const client = {
      files: {
        get: async () => {
          throw transient;
        },
      },
      changes: {
        list: async () => ({
          data: {
            changes: [
              {
                fileId: "session",
                file: {
                  id: "session",
                  name: "session.md",
                  mimeType: "text/markdown",
                  parents: ["inbox"],
                  trashed: false,
                },
              },
            ],
            newStartPageToken: "11",
          },
        }),
      },
    };
    const drive = new GoogleDrive({
      client: client as never,
      rootFolderId: "root",
    });

    await expect(
      drive.changes({ prefix: "inbox/", cursor: "10" }),
    ).rejects.toBe(transient);
  });

  describe("folders in the change feed", () => {
    const entries = [
      { id: "inbox", name: "inbox", mimeType: folderMimeType, parents: ["root"] },
      { id: "device", name: "mac", mimeType: folderMimeType, parents: ["inbox"] },
      { id: "inside", name: "session.md", mimeType: "text/markdown", parents: ["device"] },
    ].map((entry) => ({
      ...entry,
      size: "1",
      modifiedTime: "2026-07-26T00:00:00.000Z",
      appProperties: {},
      version: "1",
      trashed: false,
    }));

    function driveWithFeed(feed: () => Array<{ fileId: string; file: Record<string, unknown> }>) {
      const lists: string[] = [];
      const client = {
        files: {
          list: async (request: { q?: string }) => {
            lists.push(request.q ?? "");
            const parent = /^'([^']+)' in parents/u.exec(request.q ?? "")?.[1];
            return { data: { files: entries.filter((entry) => entry.parents.includes(parent ?? "")) } };
          },
          get: async (request: { fileId?: string }) => {
            const entry = entries.find((candidate) => candidate.id === request.fileId);
            if (!entry) throw new Error(`missing ${request.fileId}`);
            return { data: entry };
          },
        },
        changes: {
          list: async () => ({ data: { changes: feed(), newStartPageToken: "11" } }),
        },
      };
      const drive = new GoogleDrive({ client: client as never, rootFolderId: "root" });
      return { drive, lists };
    }

    it("lists only the subtree of a folder it has not seen, without a reset", async () => {
      const { drive, lists } = driveWithFeed(() => [{ fileId: "device", file: entries[1] ?? {} }]);

      const changes = await drive.changes({ prefix: "inbox/", cursor: "10" });

      expect(changes).toMatchObject({ cursor: "11", reset: false, removedIds: [] });
      expect(changes.entries.map((entry) => entry.path)).toEqual(["inbox/mac/session.md"]);
      // Only the new folder was listed, not the whole inbox.
      expect(lists).toHaveLength(1);
    });

    it("ignores a folder whose name and parent are unchanged", async () => {
      const { drive, lists } = driveWithFeed(() => [{ fileId: "device", file: entries[1] ?? {} }]);
      await drive.list({ prefix: "inbox/" });
      lists.length = 0;

      const changes = await drive.changes({ prefix: "inbox/", cursor: "10" });

      expect(changes).toMatchObject({ reset: false, entries: [], removedIds: [] });
      expect(lists).toHaveLength(0);
    });

    it("rebuilds the indexed subtree when a known folder is renamed", async () => {
      let renamed = false;
      const { drive } = driveWithFeed(() => [
        { fileId: "device", file: renamed ? { ...entries[1], name: "mac-2" } : (entries[1] ?? {}) },
      ]);
      await drive.list({ prefix: "inbox/" });
      renamed = true;

      const changes = await drive.changes({ prefix: "inbox/", cursor: "10" });

      expect(changes).toMatchObject({ cursor: "11", reset: true, removedIds: [] });
      expect(changes.entries.map((entry) => entry.id)).toEqual(["inside"]);
    });
  });

  it("finds app-property matches with one query and keeps only the requested prefix subtree", async () => {
    const entries = [
      {
        id: "inbox",
        name: "inbox",
        mimeType: folderMimeType,
        parents: ["root"],
        appProperties: {},
      },
      {
        id: "device",
        name: "device",
        mimeType: folderMimeType,
        parents: ["inbox"],
        appProperties: {},
      },
      {
        id: "inside",
        name: "inside.md",
        mimeType: "text/markdown",
        parents: ["device"],
        appProperties: { brainhubKey: "shared" },
      },
      {
        id: "sessions",
        name: "sessions",
        mimeType: folderMimeType,
        parents: ["root"],
        appProperties: {},
      },
      {
        id: "outside",
        name: "outside.md",
        mimeType: "text/markdown",
        parents: ["sessions"],
        appProperties: { brainhubKey: "shared" },
      },
    ].map((entry) => ({
      ...entry,
      size: "1",
      modifiedTime: "2026-07-26T00:00:00.000Z",
      version: "1",
      trashed: false,
    }));
    const metadataGets: string[] = [];
    const queries: string[] = [];
    const pageSizes: number[] = [];
    const client = {
      files: {
        list: async (request: { q?: string; pageSize?: number }) => {
          const query = request.q ?? "";
          queries.push(query);
          pageSizes.push(request.pageSize ?? 0);
          if (query.includes("appProperties has")) {
            return {
              data: {
                files: entries.filter(
                  (entry) => entry.appProperties.brainhubKey === "shared",
                ),
              },
            };
          }
          const parent = /^'([^']+)' in parents/u.exec(query)?.[1];
          return {
            data: {
              files: entries.filter((entry) =>
                entry.parents.includes(parent ?? ""),
              ),
            },
          };
        },
        get: async (request: { fileId?: string }) => {
          metadataGets.push(request.fileId ?? "");
          const entry = entries.find(
            (candidate) => candidate.id === request.fileId,
          );
          if (!entry) throw new Error(`missing ${request.fileId}`);
          return { data: entry, headers: { etag: "etag" } };
        },
      },
    };
    const drive = new GoogleDrive({
      client: client as never,
      rootFolderId: "root",
    });

    const result = await drive.list({
      prefix: "inbox/",
      appProperty: { key: "brainhubKey", value: "shared" },
    });

    expect(result.map((entry) => entry.path)).toEqual([
      "inbox/device/inside.md",
    ]);
    expect(queries.filter((query) => query.includes("appProperties has"))).toHaveLength(1);
    // One lookup, not a walk of the prefix tree: no per-folder child listing.
    expect(queries.some((query) => /^'[^']+' in parents/u.test(query))).toBe(false);
    expect(pageSizes.every((pageSize) => pageSize === 1_000)).toBe(true);
  });

  it("lists candidates from every duplicate prefix folder", async () => {
    const entries = [
      {
        id: "inbox-a",
        name: "inbox",
        mimeType: folderMimeType,
        parents: ["root"],
        appProperties: {},
      },
      {
        id: "inbox-b",
        name: "inbox",
        mimeType: folderMimeType,
        parents: ["root"],
        appProperties: {},
      },
      {
        id: "device-a",
        name: "mac-a",
        mimeType: folderMimeType,
        parents: ["inbox-a"],
        appProperties: {},
      },
      {
        id: "device-b",
        name: "mac-b",
        mimeType: folderMimeType,
        parents: ["inbox-b"],
        appProperties: {},
      },
      {
        id: "inside-a",
        name: "candidate-a.md",
        mimeType: "text/markdown",
        parents: ["device-a"],
        appProperties: { brainhubKey: "shared" },
      },
      {
        id: "inside-b",
        name: "candidate-b.md",
        mimeType: "text/markdown",
        parents: ["device-b"],
        appProperties: { brainhubKey: "shared" },
      },
    ].map((entry) => ({
      ...entry,
      size: "1",
      modifiedTime: "2026-07-26T00:00:00.000Z",
      version: "1",
      trashed: false,
    }));
    const client = {
      files: {
        list: async (request: { q?: string }) => {
          if ((request.q ?? "").includes("appProperties has")) {
            return {
              data: {
                files: entries.filter(
                  (entry) => entry.appProperties.brainhubKey === "shared",
                ),
              },
            };
          }
          const parent = /^'([^']+)' in parents/u.exec(request.q ?? "")?.[1];
          return {
            data: {
              files: entries.filter((entry) =>
                entry.parents.includes(parent ?? ""),
              ),
            },
          };
        },
        get: async (request: { fileId?: string }) => {
          const entry = entries.find((candidate) => candidate.id === request.fileId);
          if (!entry) throw new Error(`missing ${request.fileId}`);
          return { data: entry, headers: { etag: "etag" } };
        },
      },
    };
    const drive = new GoogleDrive({
      client: client as never,
      rootFolderId: "root",
    });

    const result = await drive.list({
      prefix: "inbox/",
      appProperty: { key: "brainhubKey", value: "shared" },
    });

    expect(result.map((entry) => entry.id).sort()).toEqual([
      "inside-a",
      "inside-b",
    ]);
  });

  it("reads a fixed file relative to the resolved My Drive root", async () => {
    const profile = {
      id: "profile-1",
      name: "Digital_Twin_Profile.md",
      mimeType: "text/markdown",
      parents: ["my-drive-root"],
      size: "15",
      modifiedTime: "2026-07-25T00:00:00.000Z",
      appProperties: {},
      version: "1",
      trashed: false,
    };
    const listedParents: string[] = [];
    const client = {
      files: {
        list: async (request: { q?: string }) => {
          listedParents.push(request.q ?? "");
          return { data: { files: [profile] } };
        },
        get: async (request: { fileId?: string; alt?: string }) => {
          if (request.fileId === "root") {
            return { data: { id: "my-drive-root" } };
          }
          if (request.alt === "media") {
            return { data: Buffer.from("# Digital Twin\n") };
          }
          return { data: profile, headers: { etag: "profile-etag" } };
        },
      },
    };

    const drive = await GoogleDrive.openMyDrive(client as never);
    const result = await drive.readPath("Digital_Twin_Profile.md");

    expect(result?.bytes.toString("utf8")).toBe("# Digital Twin\n");
    expect(listedParents).toContain(
      "'my-drive-root' in parents and name = 'Digital_Twin_Profile.md' and trashed = false",
    );
  });

  it("exports a Google Docs profile as Markdown", async () => {
    const profile = {
      id: "profile-doc",
      name: "Digital_Twin_Profile.md",
      mimeType: "application/vnd.google-apps.document",
      parents: ["my-drive-root"],
      size: "0",
      modifiedTime: "2026-07-25T00:00:00.000Z",
      appProperties: {},
      version: "1",
      trashed: false,
    };
    let exportedMimeType: string | undefined;
    const client = {
      files: {
        list: async () => ({ data: { files: [profile] } }),
        get: async (request: { fileId?: string; alt?: string }) => {
          if (request.fileId === "root") {
            return { data: { id: "my-drive-root" } };
          }
          if (request.alt === "media") {
            throw new Error("Google Docs cannot use media download");
          }
          return { data: profile, headers: { etag: "profile-etag" } };
        },
        export: async (request: { mimeType?: string }) => {
          exportedMimeType = request.mimeType;
          return { data: Buffer.from("# Exported Digital Twin\n") };
        },
      },
    };

    const drive = await GoogleDrive.openMyDrive(client as never);
    const result = await drive.readPath("Digital_Twin_Profile.md");

    expect(exportedMimeType).toBe("text/markdown");
    expect(result?.bytes.toString("utf8")).toBe("# Exported Digital Twin\n");
  });

  it("reuses an existing named root folder", async () => {
    let createCalls = 0;
    let query = "";
    const client = {
      files: {
        list: async (request: { q: string }) => {
          query = request.q;
          return { data: { files: [{ id: "existing-root" }] } };
        },
        create: async () => {
          createCalls += 1;
          return { data: { id: "new-root" } };
        },
      },
    };

    await expect(
      GoogleDrive.createRoot(client as never, "brain-hub"),
    ).resolves.toBe("existing-root");
    expect(createCalls).toBe(0);
    expect(query).toContain("'root' in parents");
  });

  it("creates a missing BrainHub folder explicitly under My Drive root", async () => {
    let parents: string[] | undefined;
    const client = {
      files: {
        list: async () => ({ data: { files: [] } }),
        create: async (request: { requestBody?: { parents?: string[] } }) => {
          parents = request.requestBody?.parents;
          return { data: { id: "new-root" } };
        },
      },
    };

    await expect(
      GoogleDrive.createRoot(client as never, "brain-hub"),
    ).resolves.toBe("new-root");
    expect(parents).toEqual(["root"]);
  });

  it("requires an explicit choice when duplicate root folders exist", async () => {
    const client = {
      files: {
        list: async () => ({
          data: { files: [{ id: "root-a" }, { id: "root-b" }] },
        }),
        create: async () => ({ data: { id: "new-root" } }),
      },
    };

    await expect(
      GoogleDrive.createRoot(client as never, "brain-hub"),
    ).rejects.toMatchObject({
      code: "DRIVE_ROOT_CONFLICT",
      candidates: ["root-a", "root-b"],
    });
    await expect(
      GoogleDrive.createRoot(client as never, "brain-hub", "root-b"),
    ).resolves.toBe("root-b");
  });

  it("requires an explicit BrainHub root", () => {
    expect(
      () => new GoogleDrive({ client: {} as never, rootFolderId: "" }),
    ).toThrow(/Drive root/);
  });

  it("rejects paths outside the configured root before calling Google", async () => {
    const drive = new GoogleDrive({
      client: {} as never,
      rootFolderId: "root",
    });
    await expect(
      drive.put({
        path: "../outside.md",
        bytes: Buffer.from("x"),
        mimeType: "text/plain",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("creates shared folder paths once during concurrent writes", async () => {
    const { client, files } = createConcurrentDriveClient();
    const drive = new GoogleDrive({
      client: client as never,
      rootFolderId: "root",
    });

    await Promise.all([
      drive.put({
        path: "inbox/macbook/first.md",
        bytes: Buffer.from("first"),
        mimeType: "text/markdown",
      }),
      drive.put({
        path: "inbox/macbook/second.md",
        bytes: Buffer.from("second"),
        mimeType: "text/markdown",
      }),
    ]);

    const folders = files.filter((file) => file.mimeType === folderMimeType);
    expect(folders.filter((folder) => folder.name === "inbox")).toHaveLength(1);
    expect(folders.filter((folder) => folder.name === "macbook")).toHaveLength(
      1,
    );
  });

  it("reuses cached folder levels for a second lookup in the same directory", async () => {
    const { client, listQueries } = createTreeDriveClient(treeSeed());
    const drive = new GoogleDrive({ client: client as never, rootFolderId: "root" });

    expect((await drive.findByPath("inbox/mac/a.md"))?.id).toBe("file-a");
    const firstLookup = listQueries.length;
    expect((await drive.findByPath("inbox/mac/b.md"))?.id).toBe("file-b");

    expect(firstLookup).toBe(3);
    expect(listQueries.length - firstLookup).toBe(1);
  });

  it("expires cached folder levels after 60 seconds", async () => {
    const { client, listQueries } = createTreeDriveClient(treeSeed());
    let now = 1_000_000;
    const drive = new GoogleDrive({ client: client as never, rootFolderId: "root", now: () => now });
    await drive.findByPath("inbox/mac/a.md");

    const withinTtl = listQueries.length;
    now += 59_999;
    await drive.findByPath("inbox/mac/b.md");
    expect(listQueries.length - withinTtl).toBe(1);

    const beforeExpiry = listQueries.length;
    now += 1;
    await drive.findByPath("inbox/mac/b.md");
    expect(listQueries.length - beforeExpiry).toBe(3);
  });

  it("forgets cached folder levels after a folder is created", async () => {
    const { client, listQueries } = createTreeDriveClient(treeSeed());
    const drive = new GoogleDrive({ client: client as never, rootFolderId: "root" });
    await drive.findByPath("inbox/mac/a.md");

    await drive.ensureFolder("inbox/other");
    const beforeLookup = listQueries.length;
    expect((await drive.findByPath("inbox/mac/a.md"))?.id).toBe("file-a");
    expect(listQueries.length - beforeLookup).toBe(3);
  });

  it("forgets cached folder levels after a folder is renamed", async () => {
    const { client } = createTreeDriveClient(treeSeed());
    const drive = new GoogleDrive({ client: client as never, rootFolderId: "root" });
    expect((await drive.findByPath("inbox/mac/a.md"))?.id).toBe("file-a");

    await drive.rename("mac-folder", "mac-renamed");

    expect(await drive.findByPath("inbox/mac/a.md")).toBeNull();
    expect((await drive.findByPath("inbox/mac-renamed/a.md"))?.id).toBe("file-a");
  });

  it("walks many folders a few at a time and keeps the breadth-first order", async () => {
    const entries: Array<{ id: string; parents: string[]; [key: string]: unknown }> = [
      { id: "inbox", name: "inbox", mimeType: folderMimeType, parents: ["root"] },
    ];
    for (let device = 0; device < 20; device += 1) {
      const id = `dev-${String(device).padStart(2, "0")}`;
      entries.push({ id, name: id, mimeType: folderMimeType, parents: ["inbox"] });
      entries.push({ id: `${id}-file`, name: "a.md", mimeType: "text/markdown", parents: [id] });
    }
    const full = entries.map((entry) => ({
      size: "1",
      modifiedTime: "2026-07-26T00:00:00.000Z",
      appProperties: {},
      version: "1",
      trashed: false,
      ...entry,
    }));
    let inFlight = 0;
    let peak = 0;
    const client = {
      files: {
        list: async (request: { q?: string }) => {
          const parent = /^'([^']+)' in parents/u.exec(request.q ?? "")?.[1];
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return { data: { files: full.filter((entry) => entry.parents.includes(parent ?? "")) } };
        },
        get: async (request: { fileId?: string }) => {
          const entry = full.find((candidate) => candidate.id === request.fileId);
          if (!entry) throw new Error(`missing ${request.fileId}`);
          return { data: entry, headers: { etag: "etag" } };
        },
      },
    };
    const drive = new GoogleDrive({ client: client as never, rootFolderId: "root" });

    const result = await drive.list({ prefix: "inbox/" });

    expect(result.map((entry) => entry.path)).toEqual(
      Array.from({ length: 20 }, (_, device) => `inbox/dev-${String(device).padStart(2, "0")}/a.md`),
    );
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("resolves the paths of many changed files with a request per folder, not per file", async () => {
    const folders: Record<string, { name: string; parents: string[] }> = {
      inbox: { name: "inbox", parents: ["root"] },
      dev: { name: "mac", parents: ["inbox"] },
      day: { name: "2026-10-24", parents: ["dev"] },
    };
    const changes = Array.from({ length: 300 }, (_, index) => ({
      fileId: `f-${index}`,
      removed: false,
      file: {
        id: `f-${index}`,
        name: `s-${index}.md`,
        mimeType: "text/markdown",
        parents: ["day"],
        size: "1",
        modifiedTime: "2026-10-24T00:00:00.000Z",
        appProperties: {},
        version: "1",
        trashed: false,
      },
    }));
    const gets: string[] = [];
    const client = {
      changes: {
        list: async () => ({ data: { changes, newStartPageToken: "next" } }),
      },
      files: {
        get: async (request: { fileId?: string }) => {
          gets.push(request.fileId ?? "");
          const folder = folders[request.fileId ?? ""];
          if (!folder) throw new Error(`missing ${request.fileId}`);
          return { data: { id: request.fileId, mimeType: folderMimeType, ...folder } };
        },
      },
    };
    const drive = new GoogleDrive({ client: client as never, rootFolderId: "root" });

    const result = await drive.changes({ prefix: "inbox/", cursor: "start" });

    expect(result.entries).toHaveLength(300);
    expect(result.entries[0]?.path).toBe("inbox/mac/2026-10-24/s-0.md");
    expect(result.cursor).toBe("next");
    // Three folders above the files, each looked up once.
    expect(gets.sort()).toEqual(["day", "dev", "inbox"]);
  });
});

function treeSeed() {
  return [
    { id: "inbox", name: "inbox", mimeType: folderMimeType, parents: ["root"] },
    { id: "mac-folder", name: "mac", mimeType: folderMimeType, parents: ["inbox"] },
    { id: "file-a", name: "a.md", mimeType: "text/markdown", parents: ["mac-folder"] },
    { id: "file-b", name: "b.md", mimeType: "text/markdown", parents: ["mac-folder"] },
  ];
}

function createTreeDriveClient(seed: ReturnType<typeof treeSeed>) {
  const files = seed.map((file) => ({
    ...file,
    size: "1",
    createdTime: "2026-07-26T00:00:00.000Z",
    modifiedTime: "2026-07-26T00:00:00.000Z",
    appProperties: {} as Record<string, string>,
    version: "1",
    trashed: false,
  }));
  const listQueries: string[] = [];
  const find = (id: string | undefined) => {
    const file = files.find((item) => item.id === id);
    if (!file) throw new Error(`missing Drive file ${id}`);
    return file;
  };
  const client = {
    files: {
      list: async (request: { q?: string }) => {
        listQueries.push(request.q ?? "");
        const parent = /^'([^']+)' in parents/u.exec(request.q ?? "")?.[1];
        return {
          data: {
            files: files
              .filter((file) => file.parents.includes(parent ?? "") && !file.trashed)
              .map((file) => ({ ...file })),
          },
        };
      },
      create: async (request: {
        requestBody?: { name?: string; mimeType?: string; parents?: string[] };
      }) => {
        const body = request.requestBody;
        if (!body?.name) throw new Error("missing file name");
        const id = `created-${files.length}`;
        files.push({
          id,
          name: body.name,
          mimeType: body.mimeType ?? "application/octet-stream",
          parents: body.parents ?? [],
          size: "0",
          createdTime: "2026-07-26T00:00:00.000Z",
          modifiedTime: "2026-07-26T00:00:00.000Z",
          appProperties: {},
          version: "1",
          trashed: false,
        });
        return { data: { id } };
      },
      get: async (request: { fileId?: string }) => ({
        data: { ...find(request.fileId) },
        headers: {},
      }),
      update: async (request: { fileId?: string; requestBody?: { name?: string } }) => {
        const file = find(request.fileId);
        if (request.requestBody?.name) file.name = request.requestBody.name;
        return { data: { ...file }, headers: {} };
      },
    },
  };
  return { client, listQueries };
}

describe("request deadlines", () => {
  const note = {
    id: "file-1",
    name: "note.md",
    mimeType: "text/markdown",
    parents: ["root"],
    size: "4",
    modifiedTime: "2026-07-26T00:00:00.000Z",
    appProperties: {},
    version: "1",
    trashed: false,
  };

  it("rejects a hung files.get from read with DRIVE_REQUEST_TIMEOUT", async () => {
    const drive = new GoogleDrive({
      client: { files: { get: () => new Promise(() => {}) } } as never,
      rootFolderId: "root",
      requestDeadlineMs: 50,
    });
    const started = performance.now();

    await expect(drive.read("file-1")).rejects.toMatchObject({
      code: "DRIVE_REQUEST_TIMEOUT",
      message: "Google Drive request timed out: files.get",
    });

    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("rejects a hung files.list from list with DRIVE_REQUEST_TIMEOUT", async () => {
    const drive = new GoogleDrive({
      client: { files: { list: () => new Promise(() => {}) } } as never,
      rootFolderId: "root",
      requestDeadlineMs: 50,
    });
    const started = performance.now();

    await expect(drive.list({ prefix: "inbox/" })).rejects.toMatchObject({
      code: "DRIVE_REQUEST_TIMEOUT",
      message: "Google Drive request timed out: files.list",
    });

    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("returns a fast read unchanged when requestDeadlineMs is large", async () => {
    const get = mock(function (this: unknown, request: { alt?: string }) {
      if (request.alt === "media") return { data: Buffer.from("fast") };
      return { data: note, headers: { etag: "e" } };
    });
    const files = { get };
    const drive = new GoogleDrive({
      client: { files } as never,
      rootFolderId: "root",
      requestDeadlineMs: 60_000,
    });

    const result = await drive.read("file-1");

    expect(result.bytes.toString("utf8")).toBe("fast");
    expect(get.mock.contexts.length).toBeGreaterThan(0);
    expect(get.mock.contexts.every((receiver) => receiver === files)).toBe(true);
  });
});

describe("request deadlines on a real googleapis client", () => {
  it("calls every resource method without a TypeError and times out a stalled response body", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.includes("/changes")) {
          return Response.json({ changes: [], newStartPageToken: "1" });
        }
        // Headers arrive, the body never finishes.
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"files":['));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    try {
      const client = google.drive({
        version: "v3",
        rootUrl: `http://127.0.0.1:${server.port}/`,
      });
      const drive = new GoogleDrive({
        client,
        rootFolderId: "root",
        requestDeadlineMs: 300,
      });
      const started = performance.now();
      await expect(drive.list({ prefix: "inbox/" })).rejects.toMatchObject({
        code: "DRIVE_REQUEST_TIMEOUT",
      });
      expect(performance.now() - started).toBeLessThan(3_000);
      // `changes` is a different resource; a Proxy-based wrapper threw a TypeError here.
      await expect(drive.changes({ prefix: "inbox/", cursor: "5" })).resolves.toMatchObject({
        cursor: "1",
      });
    } finally {
      await server.stop(true);
    }
  });
});
