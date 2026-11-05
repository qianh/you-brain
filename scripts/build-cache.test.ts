import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cachedTree, hashDir, hashInputs, runInstall } from "./build-cache.ts";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "build-cache-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function writer(content: string, counter: { builds: number }) {
  return async (out: string): Promise<void> => {
    counter.builds += 1;
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "file.txt"), content);
  };
}

describe("cachedTree", () => {
  it("reuses the result while the key stays the same", async () => {
    const root = await tempDir();
    const counter = { builds: 0 };
    const options = { cacheRoot: join(root, "cache"), name: "vendor", key: "a".repeat(64), env: {} };
    const dest = join(root, "out", "vendor");

    expect(await cachedTree({ ...options, dest, build: writer("first", counter) })).toBe("miss");
    await writeFile(join(dest, "file.txt"), "changed by a later step");
    expect(await cachedTree({ ...options, dest, build: writer("second", counter) })).toBe("hit");

    expect(counter.builds).toBe(1);
    expect(await readFile(join(dest, "file.txt"), "utf8")).toBe("first");
  });

  it("rebuilds when the key changes and drops the older entry", async () => {
    const root = await tempDir();
    const counter = { builds: 0 };
    const cacheRoot = join(root, "cache");
    const dest = join(root, "vendor");
    const base = { cacheRoot, name: "vendor", dest, env: {} };
    await mkdir(join(cacheRoot, "other-1234"), { recursive: true });

    await cachedTree({ ...base, key: "a".repeat(64), build: writer("old", counter) });
    await cachedTree({ ...base, key: "b".repeat(64), build: writer("new", counter) });

    expect(counter.builds).toBe(2);
    expect(await readFile(join(dest, "file.txt"), "utf8")).toBe("new");
    expect((await readdir(cacheRoot)).sort()).toEqual(["other-1234", `vendor-${"b".repeat(16)}`]);
  });

  it("leaves nothing reusable when the build fails", async () => {
    const root = await tempDir();
    const counter = { builds: 0 };
    const options = {
      cacheRoot: join(root, "cache"),
      name: "vendor",
      key: "a".repeat(64),
      dest: join(root, "vendor"),
      env: {},
    };

    const failed = cachedTree({
      ...options,
      build: async (out) => {
        await mkdir(out, { recursive: true });
        throw new Error("network");
      },
    });
    await expect(failed).rejects.toThrow("network");

    expect(await readdir(options.cacheRoot)).toEqual([]);
    expect(await cachedTree({ ...options, build: writer("ok", counter) })).toBe("miss");
  });

  it("can be told to reinstall", async () => {
    const root = await tempDir();
    const counter = { builds: 0 };
    const base = {
      cacheRoot: join(root, "cache"),
      name: "vendor",
      key: "a".repeat(64),
      dest: join(root, "vendor"),
    };

    await cachedTree({ ...base, env: {}, build: writer("first", counter) });
    const result = await cachedTree({
      ...base,
      env: { YOU_BRAIN_NO_BUILD_CACHE: "1" },
      build: writer("second", counter),
    });

    expect(result).toBe("miss");
    expect(await readFile(join(base.dest, "file.txt"), "utf8")).toBe("second");
  });

  it("keeps symlinks as links, which dsh node_modules/.bin relies on", async () => {
    const root = await tempDir();
    const dest = join(root, "modules");
    await cachedTree({
      cacheRoot: join(root, "cache"),
      name: "dsh",
      key: "a".repeat(64),
      dest,
      env: {},
      build: async (out) => {
        await mkdir(join(out, ".bin"), { recursive: true });
        await writeFile(join(out, "tool.js"), "x");
        await symlink("../tool.js", join(out, ".bin", "tool"));
      },
    });

    expect(await readlink(join(dest, ".bin", "tool"))).toBe("../tool.js");
  });
});

describe("hashes", () => {
  it("does not confuse where one input ends and the next begins", () => {
    expect(hashInputs(["ab", "c"])).not.toBe(hashInputs(["a", "bc"]));
  });

  it("changes with file content and path, not with write order", async () => {
    const one = await tempDir();
    await writeFile(join(one, "a.txt"), "1");
    await writeFile(join(one, "b.txt"), "2");
    const two = await tempDir();
    await writeFile(join(two, "b.txt"), "2");
    await writeFile(join(two, "a.txt"), "1");
    expect(await hashDir(one)).toBe(await hashDir(two));

    await writeFile(join(two, "a.txt"), "changed");
    expect(await hashDir(one)).not.toBe(await hashDir(two));
  });
});

describe("runInstall", () => {
  it("retries after a failure", async () => {
    const cwd = await tempDir();
    const script = 'if [ -f tried ]; then exit 0; fi; touch tried; exit 3';
    await runInstall(["sh", "-c", script], cwd);
    expect(await readdir(cwd)).toEqual(["tried"]);
  });

  it("ends a stuck install and reports it", async () => {
    const cwd = await tempDir();
    const stuck = runInstall(["sleep", "30"], cwd, { timeoutMs: 100, attempts: 2 });
    await expect(stuck).rejects.toThrow("已重试 2 次");
  });

  it("skips the proxy on the first attempt and falls back to it", async () => {
    const cwd = await tempDir();
    const script = 'printf "[%s]" "$HTTPS_PROXY" >> seen; [ -n "$HTTPS_PROXY" ]';
    const saved = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://proxy.test:1";
    try {
      await runInstall(["sh", "-c", script], cwd, { directFirst: true });
    } finally {
      if (saved === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved;
    }
    expect(await readFile(join(cwd, "seen"), "utf8")).toBe("[][http://proxy.test:1]");
  });

  it("defaults to the mirror and honours a registry the caller set", async () => {
    const cwd = await tempDir();
    await runInstall(["sh", "-c", 'printf "%s" "$BUN_CONFIG_REGISTRY" > seen'], cwd, {
      env: { BUN_CONFIG_REGISTRY: "https://example.test" },
    });
    expect(await readFile(join(cwd, "seen"), "utf8")).toBe("https://example.test");
  });
});
