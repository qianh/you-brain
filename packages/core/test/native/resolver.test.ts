import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "bun:test";

import { DESKTOP_PRODUCT_NAME } from "../../src/native/layout.js";
import { exportTarget, resolveVendorEntry, vendorNodeModulesDir } from "../../src/native/resolver.js";

describe("vendor package entry", () => {
  it("prefers package.json main, and the node export over the web build", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-vendor-entry-"));
    const pkg = join(root, "node_modules", "demo");
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "main.cjs"), "module.exports = { kind: 'main' };\n");
    await writeFile(join(pkg, "node.cjs"), "module.exports = { kind: 'node' };\n");
    await writeFile(join(pkg, "web.js"), "export default 'web';\n");
    await writeFile(join(pkg, "extra-node.cjs"), "module.exports = { kind: 'extra' };\n");
    await writeFile(join(pkg, "extra-web.js"), "export default 'extra-web';\n");
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "demo",
        main: "./main.cjs",
        exports: {
          ".": {
            default: "./web.js",
            node: { require: { default: "./node.cjs" } },
          },
          "./extra": {
            default: "./extra-web.js",
            node: "./extra-node.cjs",
          },
        },
      }),
    );

    expect(resolveVendorEntry(join(root, "node_modules"), "demo")).toBe(join(pkg, "main.cjs"));
    expect(resolveVendorEntry(join(root, "node_modules"), "demo/extra")).toBe(
      join(pkg, "extra-node.cjs"),
    );
    expect(
      exportTarget({
        default: "./web.js",
        node: { require: { default: "./node.cjs" } },
      }),
    ).toBe("./node.cjs");
  });

  it("resolves a scoped package from exports when main is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-vendor-scope-"));
    const pkg = join(root, "node_modules", "@huggingface", "transformers");
    await mkdir(join(pkg, "dist"), { recursive: true });
    await writeFile(join(pkg, "dist", "transformers.node.cjs"), "module.exports = {};\n");
    await writeFile(join(pkg, "dist", "transformers.web.js"), "export default {};\n");
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "@huggingface/transformers",
        exports: {
          ".": {
            node: { require: { default: "./dist/transformers.node.cjs" } },
            default: { default: "./dist/transformers.web.js" },
          },
        },
      }),
    );
    expect(resolveVendorEntry(join(root, "node_modules"), "@huggingface/transformers")).toBe(
      join(pkg, "dist", "transformers.node.cjs"),
    );
  });
});

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("vendor directory", () => {
  it("reads productName from tauri.conf.json", () => {
    const configPath = fileURLToPath(
      new URL("../../../../apps/desktop/src-tauri/tauri.conf.json", import.meta.url),
    );
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { productName: string };
    expect(DESKTOP_PRODUCT_NAME).toBe(config.productName);
    expect(DESKTOP_PRODUCT_NAME).toBe("you-brain");
  });

  it("finds Linux usr/lib/<productName>/vendor/node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-vendor-linux-"));
    roots.push(root);
    const execPath = join(root, "usr", "bin", "you-brain");
    const linux = join(root, "usr", "lib", "you-brain", "vendor", "node_modules");
    const sibling = join(root, "usr", "bin", "vendor", "node_modules");
    await mkdir(linux, { recursive: true });
    expect(vendorNodeModulesDir(execPath)).toBe(linux);

    await mkdir(sibling, { recursive: true });
    expect(vendorNodeModulesDir(execPath)).toBe(sibling);
  });

  it("prefers macOS Resources over the Linux layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-vendor-mac-"));
    roots.push(root);
    const execPath = join(root, "App.app", "Contents", "MacOS", "you-brain");
    const resources = join(root, "App.app", "Contents", "Resources", "vendor", "node_modules");
    const linux = join(root, "App.app", "Contents", "lib", "you-brain", "vendor", "node_modules");
    await mkdir(resources, { recursive: true });
    await mkdir(linux, { recursive: true });
    expect(vendorNodeModulesDir(execPath)).toBe(resources);
  });
});
