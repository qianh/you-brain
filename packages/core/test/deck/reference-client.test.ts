import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const code = readFileSync(new URL("../../../../sidecars/dsh-host/plugins/u-brain-reference/lib/client.js", import.meta.url), "utf8");
const mention = "@[Codex %140](u-brain-tty7:eyJwYW5lIjoxNDB9)";
const identity = { pane: 140, workspaceId: "qa-ws", tabId: "qa-tab" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 运行插件公开的 source / slot 契约；不依赖浏览器或 DSH 的构建链。 */
function client(fetch: (url: string, init: any) => Promise<unknown>) {
  let plugin: any;
  let source: any;
  let rule: any;
  const slots = new Map<string, { component: any; options: any }>();
  const listeners = new Map<string, (event: any) => void>();
  const cleanups: Array<() => void> = [];
  const posts: Array<{ data: any; origin: string }> = [];
  const parent = { postMessage: (data: any, origin: string) => posts.push({ data, origin }) };
  const jsx = (type: any, props: any) => ({ type, props });
  runInNewContext(code, {
    window: {
      parent,
      addEventListener: (type: string, fn: (event: any) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
      __ModuleLoader__: { load: ({ factory }: any) => {
        plugin = factory((name: string) => {
          if (name === "react") return { useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() };
          if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
          if (name === "@deepseek-ai/dsh-client-ui-primitives") return { Modal: "Modal", Button: "Button", ReferenceChip: "ReferenceChip" };
          throw new Error(`Unexpected module: ${name}`);
        });
      } },
    },
    AbortController, URLSearchParams, fetch, console,
  });
  plugin.apply({
    effect: (effect: () => (() => void) | undefined) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); },
    get: () => ({ registerSource: (value: unknown) => { source = value; return () => {}; } }),
    uiConversation: { userText: { register: (value: unknown) => { rule = value; } } },
    slots: {
      register: (options: any, component: unknown) => {
        // DSH SlotCore: shell.overlay 是 list，conversation.user.text.node 是 keyed。
        if (options.name === "shell.overlay" && options.id === undefined) {
          throw new Error('list slot "shell.overlay" requires options.id');
        }
        slots.set(options.id ?? options.key, { component, options });
        return () => {};
      },
      inject: (_slot: string, callback: () => any) => { const result = callback(); if (result?.next) for (const _ of result) { /* 注册生成器 */ } },
    },
  });
  return {
    source, rule, slots, posts,
    host: (fromParent = true) => listeners.get("message")?.({ source: fromParent ? parent : {}, origin: "http://127.0.0.1:3921", data: { type: "u-brain:terminal-reference:host" } }),
    modal: () => { const element = slots.get("u-brain-reference-preview")!.component(); return element.type(element.props); },
    dispose: () => cleanups.forEach((cleanup) => cleanup()),
  };
}

describe("u-brain-reference 客户端", () => {
  test("预览弹层按 DSH list 槽位契约使用 id 注册", () => {
    const app = client(async () => ({ ok: true, json: async () => ({}) }));
    expect(app.slots.get("u-brain-reference-preview")?.options).toMatchObject({
      name: "shell.overlay", id: "u-brain-reference-preview",
    });
    app.dispose();
  });

  test("终端候选插入草稿，点击后预览、刷新并向已握手的宿主打开实时终端", async () => {
    let reads = 0;
    const app = client(async (url) => ({ ok: true, json: async () => url.startsWith("/u-brain/reference/candidates")
      ? { candidates: [{ kind: "tty7", label: "Codex %140", detail: "/projects/you-brain", mention }] }
      : { title: "Codex %140", text: `第 ${++reads} 次快照\n  8 pass`, terminal: identity } }));
    const rows = await app.source.candidates({}, { query: "%140" });
    expect(rows[0].section).toBe("终端会话");
    const picked = app.source.onPick({ candidate: rows[0] });
    expect(picked.insert).toMatchObject({ source: "u-brain-reference", ref: mention, appearance: "session" });
    expect(await app.source.codec.serialize(picked.insert.ref)).toBe(mention);
    expect(app.source.openReference({}, { ref: picked.insert.ref })).toBe(true);
    expect(app.modal().props.children.props.role).toBe("status");
    await settle();
    expect(app.modal().props.children.props.children).toBe("第 1 次快照\n  8 pass");
    app.modal().props.footer.props.children[0].props.onClick();
    await settle();
    expect(app.modal().props.children.props.children).toContain("第 2 次快照");
    app.host(false);
    expect(app.modal().props.footer.props.children[1]).toBeUndefined();
    app.host();
    app.modal().props.footer.props.children[1].props.onClick();
    expect(app.posts.at(-1)).toEqual({ origin: "http://127.0.0.1:3921", data: { type: "u-brain:terminal-reference:open", ...identity } });
    expect(app.modal()).toBeNull();
    app.dispose();
  });

  test("已发送引用使用同一预览入口，失败可重试，非交互渲染不激活", async () => {
    const app = client(async () => ({ ok: true, json: async () => ({ error: "原终端已关闭" }) }));
    const node = app.rule.match(`查看 ${mention}`, 0);
    const slot = app.slots.get("u-brain-mention")!;
    const props = { node, raw: mention, interactive: true, ...slot.options.inject() };
    slot.component(props).props.onActivate();
    await settle();
    expect(app.modal().props.children.props).toMatchObject({ role: "alert", children: "原终端已关闭" });
    expect(app.modal().props.footer.props.children[0].props.disabled).toBe(false);
    expect(slot.component({ ...props, interactive: false }).props.onActivate).toBeUndefined();
    app.dispose();
  });

  test("切换和关闭预览会取消旧读取，旧响应不能覆盖新引用", async () => {
    const pending: Array<{ signal: AbortSignal; resolve: (response: unknown) => void }> = [];
    const app = client((_url, init) => new Promise((resolve) => pending.push({ signal: init.signal, resolve })));
    expect(app.source.openReference({}, { ref: "bad reference" })).toBe(false);
    app.source.openReference({}, { ref: mention });
    app.source.openReference({}, { ref: mention.replace("Codex %140", "新引用") });
    expect(pending[0]!.signal.aborted).toBe(true);
    pending[1]!.resolve({ ok: true, json: async () => ({ title: "新引用", text: "最新内容" }) });
    await settle();
    pending[0]!.resolve({ ok: true, json: async () => ({ title: "旧引用", text: "旧内容" }) });
    await settle();
    expect(app.modal().props.title).toBe("新引用");
    app.modal().props.onClose();
    expect(pending[1]!.signal.aborted).toBe(true);
    expect(app.modal()).toBeNull();
    app.dispose();
  });
});
