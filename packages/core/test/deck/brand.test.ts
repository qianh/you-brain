import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "bun:test";

import { renderDshPatch } from "../../src/deck/dsh/patch.js";

const PLUGIN_DIR = join(import.meta.dirname, "..", "..", "..", "..", "sidecars", "dsh-host", "plugins", "u-brain-brand");

type Exports = { inject: string[]; apply(ctx: unknown): void };

async function load(): Promise<{ id: string; exports: Exports; styles: string[] }> {
  const code = await readFile(join(PLUGIN_DIR, "lib", "client.js"), "utf8");
  type Entry = { id: string; factory: (require: (name: string) => unknown) => Exports };
  const holder: { entry?: Entry } = {};
  const styles: string[] = [];
  const document = {
    createElement: () => {
      const el = { textContent: "", remove: () => undefined };
      styles.push("");
      Object.defineProperty(el, "textContent", { set: (v: string) => (styles[styles.length - 1] = v), get: () => "" });
      return el;
    },
    head: { appendChild: () => undefined },
  };
  vm.runInNewContext(code, { window: { __ModuleLoader__: { load: (entry: Entry) => (holder.entry = entry) } }, document });
  if (holder.entry === undefined) throw new Error("client.js 没有调用 __ModuleLoader__.load");
  const react = { createElement: (...args: unknown[]) => args };
  return { id: holder.entry.id, exports: holder.entry.factory((name) => (name === "react" ? react : undefined)), styles };
}

describe("u-brain-brand browser module", () => {
  it("occupies the sidebar and hero brand slots and rewrites the hero copy", async () => {
    const { id, exports, styles } = await load();
    const pkg = JSON.parse(await readFile(join(PLUGIN_DIR, "package.json"), "utf8")) as { name: string; dsh: { client: { platform: string } } };
    expect(id).toBe(pkg.name);
    expect(pkg.dsh.client.platform).toBe("web");
    expect(exports.inject).toEqual(["slots", "locale"]);

    const registered: string[] = [];
    const disposers: Array<() => void> = [];
    const original = (_ns: string, key: string): string => `orig:${key}`;
    const locale = { snapshot: { active: "zh" }, translate: original };
    exports.apply({
      slots: {
        inject: (_name: string, factory: () => Iterable<unknown> | unknown) => {
          const result = factory();
          if (result !== undefined && typeof (result as Iterable<unknown>)[Symbol.iterator] === "function") for (const _ of result as Iterable<unknown>) void _;
        },
        register: (options: { name: string }) => (registered.push(options.name), options),
      },
      locale,
      effect: (fn: () => () => void) => disposers.push(fn()),
    });
    expect(registered.sort()).toEqual(["conversation.hero.brand.mark", "sidebar.brand.mark", "sidebar.brand.name"]);

    expect(locale.translate("conversation", "hero.headline")).toBe("你的第二大脑，随时待命");
    expect(locale.translate("conversation", "hero.preview")).toBe("");
    expect(locale.translate("conversation", "placeholder.hero")).toBe("orig:placeholder.hero");
    expect(locale.translate("other", "hero.headline")).toBe("orig:hero.headline");
    locale.snapshot.active = "en";
    expect(locale.translate("conversation", "hero.headline")).toBe("Your second brain, on call");
    expect(styles.join("")).toContain("previewBadge");

    for (const dispose of disposers) dispose();
    expect(locale.translate).toBe(original);
  });
});

describe("renderDshPatch brandPlugin", () => {
  it("disables the official brand row and mounts the replacement", () => {
    const text = renderDshPatch({ plugins: [], brandPlugin: "u-brain-brand" });
    expect(text).toContain("- id: ui-brand-official\n  disabled: true");
    expect(text).toContain('name: "u-brain-brand"');
  });
  it("leaves the brand untouched by default", () => {
    expect(renderDshPatch({ plugins: [] })).toBe("[]\n");
  });
});
