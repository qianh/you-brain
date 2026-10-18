import { lstat, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { writeFileAtomic } from "../../src/domain/atomic.js";

describe("writeFileAtomic", () => {
  it("writes through a temporary file and creates parent directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "you-brain-atomic-"));
    const target = join(directory, "nested", "config.toml");
    await writeFileAtomic(target, "hello");
    expect(await readFile(target, "utf8")).toBe("hello");
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
    const names = await readdir(join(directory, "nested"));
    expect(names.filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("preserves a symlink and updates its target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "you-brain-link-"));
    const target = join(directory, "managed.toml");
    const link = join(directory, "config.toml");
    await writeFile(target, "previous");
    await symlink(target, link);
    await writeFileAtomic(link, "next");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("next");
  });

  it("removes the temporary file when the rename fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "you-brain-atomic-fail-"));
    const blocked = join(directory, "blocked");
    await mkdir(blocked);
    await expect(writeFileAtomic(blocked, "hello")).rejects.toThrow();
    const names = await readdir(directory);
    expect(names.filter((name) => name.includes(".tmp"))).toEqual([]);
    expect((await lstat(blocked)).isDirectory()).toBe(true);
  });
});
