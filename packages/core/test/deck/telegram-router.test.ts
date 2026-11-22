import { describe, expect, it } from "bun:test";

import {
  buildJudgeUser,
  createLlmRouteJudge,
  formatChoiceList,
  parseChoiceReply,
  parseJudgeChoice,
} from "../../src/deck/telegram/router.js";

const candidates = [
  { id: 11, deviceId: "d2", deviceName: "Mac mini", preview: "⏳ 迁移要批准吗", at: 1_000_000 - 5 * 60_000 },
  { id: 10, deviceId: "d1", deviceName: "MacBook", preview: "✅ 修登录 做完了", at: 1_000_000 - 90 * 60_000 },
];

describe("路由判断", () => {
  it("parseJudgeChoice：只认 1..N 的整数，其余都当拿不准", () => {
    expect(parseJudgeChoice('{"choice": 2}', 2)).toBe(1);
    expect(parseJudgeChoice('好的：{"choice":1}。', 2)).toBe(0);
    expect(parseJudgeChoice('{"choice": null}', 2)).toBeNull();
    expect(parseJudgeChoice('{"choice": 3}', 2)).toBeNull();
    expect(parseJudgeChoice('{"choice": 0}', 2)).toBeNull();
    expect(parseJudgeChoice('{"choice": "1"}', 2)).toBeNull();
    expect(parseJudgeChoice("不确定", 2)).toBeNull();
    expect(parseJudgeChoice("{坏的", 2)).toBeNull();
  });

  it("parseChoiceReply：序号的几种写法，越界和普通话不算", () => {
    for (const text of ["2", " 2 ", "选2", "第 2 个", "2号", "2。"]) expect(parseChoiceReply(text, 2)).toBe(1);
    expect(parseChoiceReply("1", 2)).toBe(0);
    expect(parseChoiceReply("3", 2)).toBeNull();
    expect(parseChoiceReply("0", 2)).toBeNull();
    expect(parseChoiceReply("2 点见", 2)).toBeNull();
    expect(parseChoiceReply("继续", 2)).toBeNull();
  });

  it("提示词带设备、多久以前和摘要；选择清单带序号", () => {
    const user = buildJudgeUser({ text: "迁移批准", candidates, now: 1_000_000 });
    expect(user).toContain("1. [Mac mini，5 分钟前] ⏳ 迁移要批准吗");
    expect(user).toContain("2. [MacBook，2 小时前] ✅ 修登录 做完了");
    expect(user).toContain("用户这句话：迁移批准");
    expect(formatChoiceList(candidates)).toContain("1. Mac mini：⏳ 迁移要批准吗");
  });

  it("createLlmRouteJudge：解析模型输出；没有模型、报错、乱答都返回 null", async () => {
    const input = { text: "迁移批准", candidates, now: 1_000_000 };
    let seen = "";
    const ok = createLlmRouteJudge(async () => ({
      complete: async (request) => {
        seen = request.user;
        return '{"choice": 1}';
      },
    }));
    expect(await ok(input)).toBe(0);
    expect(seen).toContain("迁移批准");
    expect(await createLlmRouteJudge(async () => null)(input)).toBeNull();
    expect(
      await createLlmRouteJudge(async () => ({
        complete: async () => {
          throw new Error("boom");
        },
      }))(input),
    ).toBeNull();
    expect(await createLlmRouteJudge(async () => ({ complete: async () => "我觉得是第一条" }))(input)).toBeNull();
  });
});
