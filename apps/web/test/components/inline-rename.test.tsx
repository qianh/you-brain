import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { beginEdit, endEdit, InlineRename, submitRename } from "../../src/components/inline-rename.js";

describe("InlineRename", () => {
  test("默认只显示标题，不显示输入框", () => {
    const html = renderToStaticMarkup(<InlineRename value="我的会话" onSubmit={async () => undefined} />);
    expect(html).toContain("我的会话");
    expect(html).not.toContain("<input");
  });
});

describe("submitRename", () => {
  const record = () => {
    const calls: string[] = [];
    return { calls, onSubmit: async (next: string): Promise<void> => { calls.push(next); } };
  };

  test("提交去掉首尾空白后的值", async () => {
    const { calls, onSubmit } = record();
    expect(await submitRename("旧名", "  新名 \n", onSubmit)).toEqual({ submitted: true, error: null });
    expect(calls).toEqual(["新名"]);
  });

  test("空白不提交", async () => {
    const { calls, onSubmit } = record();
    expect(await submitRename("旧名", "   ", onSubmit)).toEqual({ submitted: false, error: null });
    expect(calls).toEqual([]);
  });

  test("未变不提交（比较的是去空白后的值）", async () => {
    const { calls, onSubmit } = record();
    expect((await submitRename("旧名", " 旧名 ", onSubmit)).submitted).toBe(false);
    expect(calls).toEqual([]);
  });

  test("onSubmit 抛错时返回错误，由调用方恢复原值并显示", async () => {
    const result = await submitRename("旧名", "新名", async () => { throw new Error("tty7 拒绝了"); });
    expect(result.submitted).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe("tty7 拒绝了");
  });
});

describe("编辑状态（双击、外部按钮、卸载共用）", () => {
  test("beginEdit 总是从原值开始，并清掉上一次的「已结束」", () => {
    expect(beginEdit("旧名")).toEqual({ editing: true, draft: "旧名", finished: false });
  });

  test("endEdit 只在编辑进行中返回一次 commit", () => {
    const first = endEdit(beginEdit("旧名"));
    expect(first.commit).toBe(true);
    expect(first.state).toEqual({ editing: false, draft: "旧名", finished: true });
    expect(endEdit(first.state).commit).toBe(false);
  });

  test("没进入编辑时 endEdit 不提交（卸载时没有半截输入）", () => {
    expect(endEdit({ editing: false, draft: "x", finished: false }).commit).toBe(false);
  });

  test("结束后再次 beginEdit 又能提交一次", () => {
    const done = endEdit(beginEdit("a")).state;
    expect(endEdit(beginEdit("a")).commit).toBe(true);
    expect(endEdit(done).commit).toBe(false);
  });
});
