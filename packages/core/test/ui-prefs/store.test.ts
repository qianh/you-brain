import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "bun:test";

import { UiPrefsLimitError, UiPrefsStore } from "../../src/ui-prefs/store.js";

let dir: string;
let file: string;
let store: UiPrefsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yb-ui-prefs-"));
  file = join(dir, "ui-prefs.json");
  store = new UiPrefsStore(file);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("文件不存在时读到空对象", async () => { expect(await store.read()).toEqual({}); });
it("patch 按键合并并落盘", async () => {
  await store.patch({ set: { a: "1", b: "2" } });
  expect(await store.patch({ set: { b: "3" }, remove: ["a"] })).toEqual({ b: "3" });
  expect(await new UiPrefsStore(file).read()).toEqual({ b: "3" });
});
it("并发 patch 不互相覆盖", async () => {
  await Promise.all([store.patch({ set: { a: "1" } }), store.patch({ set: { b: "2" } })]);
  expect(await store.read()).toEqual({ a: "1", b: "2" });
});
it("损坏的文件改名保留，读到空对象", async () => {
  writeFileSync(file, "{broken");
  expect(await store.read()).toEqual({});
  expect(readdirSync(dir).some((name) => name.startsWith("ui-prefs.json.bad-"))).toBe(true);
});
it("读取时丢弃非字符串的值", async () => {
  writeFileSync(file, JSON.stringify({ a: "1", b: 2, c: null }));
  expect(await store.read()).toEqual({ a: "1" });
});
it("超限拒绝且不改动已有内容", async () => {
  await store.patch({ set: { a: "1" } });
  await expect(store.patch({ set: { big: "x".repeat(65537) } })).rejects.toBeInstanceOf(UiPrefsLimitError);
  await expect(store.patch({ set: { ["k".repeat(201)]: "1" } })).rejects.toBeInstanceOf(UiPrefsLimitError);
  await expect(store.patch({ set: { "": "1" } })).rejects.toBeInstanceOf(UiPrefsLimitError);
  expect(await store.read()).toEqual({ a: "1" });
});
it("整个文件超过 1 MiB 时拒绝", async () => {
  for (let i = 0; i < 15; i++) await store.patch({ set: { [`k${i}`]: "x".repeat(65536) } });
  await expect(store.patch({ set: { more: "x".repeat(65536) } })).rejects.toBeInstanceOf(UiPrefsLimitError);
  expect(Object.keys(await store.read()).length).toBe(15);
});
it("文件权限是 0600", async () => {
  await store.patch({ set: { a: "1" } });
  expect(statSync(file).mode & 0o777).toBe(0o600);
});
