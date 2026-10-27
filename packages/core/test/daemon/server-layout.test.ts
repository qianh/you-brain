import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { resolveWebDir } from "../../src/daemon/web-dir.js";
import { vendorNodeModulesDir } from "../../src/native/resolver.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * 服务器包解压后是 `bin/you-brain` + `lib/you-brain/{web,vendor}`，
 * 与 Linux 桌面包同一套布局。这两个解析函数必须能直接找到，不需要环境变量。
 */
describe("server bundle layout", () => {
  it("finds web and vendor under lib/you-brain next to the binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-server-layout-"));
    roots.push(root);
    const bundle = join(root, "you-brain-0.1.0-x86_64-unknown-linux-gnu");
    const execPath = join(bundle, "bin", "you-brain");
    await mkdir(join(bundle, "bin"), { recursive: true });
    await mkdir(join(bundle, "lib", "you-brain", "web"), { recursive: true });
    await mkdir(join(bundle, "lib", "you-brain", "vendor", "node_modules"), { recursive: true });

    expect(
      await resolveWebDir({
        env: {},
        execPath,
        moduleUrl: `file://${execPath}`,
        cwd: "/",
      }),
    ).toBe(join(bundle, "lib", "you-brain", "web"));
    expect(vendorNodeModulesDir(execPath)).toBe(
      join(bundle, "lib", "you-brain", "vendor", "node_modules"),
    );
  });
});
