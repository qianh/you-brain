import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "bun:test";

import { resolveWebDir } from "../../src/daemon/web-dir.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "you-brain-web-"));
  roots.push(root);
  return root;
}

function input(root: string, env: NodeJS.ProcessEnv, execPath: string) {
  return {
    env,
    execPath,
    moduleUrl: pathToFileURL(join(root, "module.js")).href,
    cwd: root,
  };
}

describe("resolveWebDir", () => {
  it("prefers YOU_BRAIN_WEB_DIR, then a sibling web directory, then Resources", async () => {
    const root = await tempRoot();
    const fromEnv = join(root, "from-env");
    const sibling = join(root, "app", "web");
    const resources = join(root, "You Brain.app", "Contents", "Resources", "web");
    await mkdir(fromEnv, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await mkdir(resources, { recursive: true });
    const execPath = join(root, "app", "you-brain");

    expect(
      await resolveWebDir(input(root, { YOU_BRAIN_WEB_DIR: fromEnv }, execPath)),
    ).toBe(fromEnv);
    expect(
      await resolveWebDir(input(root, { YOU_BRAIN_WEB_DIR: join(root, "missing") }, execPath)),
    ).toBe(sibling);
    expect(await resolveWebDir(input(root, {}, execPath))).toBe(sibling);

    const packaged = join(root, "You Brain.app", "Contents", "MacOS", "you-brain");
    expect(await resolveWebDir(input(root, {}, packaged))).toBe(resources);
  });

  it("walks up to apps/web/dist when nothing is packaged", async () => {
    const root = await tempRoot();
    const dist = join(root, "apps", "web", "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "index.html"), "<p>app</p>");
    const nested = join(root, "packages", "cli", "src", "index.ts");
    await mkdir(join(root, "packages", "cli", "src"), { recursive: true });
    expect(
      await resolveWebDir({
        env: {},
        execPath: join(root, "bun"),
        moduleUrl: pathToFileURL(nested).href,
        cwd: join(root, "packages", "cli"),
      }),
    ).toBe(dist);
  });

  it("returns null when every candidate is missing", async () => {
    const root = await tempRoot();
    expect(
      await resolveWebDir(input(root, { YOU_BRAIN_WEB_DIR: join(root, "nope") }, join(root, "you-brain"))),
    ).toBeNull();
  });
});
