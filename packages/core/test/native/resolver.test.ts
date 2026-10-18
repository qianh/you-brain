import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { exportTarget, resolveVendorEntry } from "../../src/native/resolver.js";

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
