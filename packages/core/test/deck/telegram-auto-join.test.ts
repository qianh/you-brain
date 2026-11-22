import type { RelayInviteFile } from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import { INVITE_REFRESH_BEFORE_MS, RelayAutoJoin, type AutoJoinPorts } from "../../src/deck/telegram/auto-join.js";

const URL = "https://relay.example.com";
const MIN = 60_000;

function world(overrides: Partial<AutoJoinPorts> & { drive?: RelayInviteFile | null; enrolled?: boolean } = {}) {
  let clock = 1_000_000;
  const state = {
    drive: overrides.drive ?? null,
    enrolled: overrides.enrolled ?? false,
    joined: [] as Array<[string, string]>,
    requested: 0,
    issued: 0,
  };
  const ports: AutoJoinPorts = {
    readInvite: async () => state.drive,
    writeInvite: async (invite) => {
      state.drive = invite;
    },
    deviceId: () => "device-self-01",
    enrolledUrl: async () => (state.enrolled ? URL : null),
    requestInvite: async () => {
      state.requested += 1;
      state.issued += 1;
      return { url: URL, code: `CODE${state.issued}XYZ`, expiresAt: new Date(clock + 10 * MIN).toISOString() };
    },
    canJoin: async () => !state.enrolled,
    join: async (url, code) => {
      state.joined.push([url, code]);
    },
    now: () => clock,
    ...overrides,
  };
  return { state, ports, advance: (ms: number) => (clock += ms), auto: new RelayAutoJoin(ports), now: () => clock };
}

describe("同账号设备自动入网", () => {
  it("已入网的设备把邀请码放进云盘，还新鲜就不再重复申请", async () => {
    const w = world({ enrolled: true });
    expect(await w.auto.run()).toBe("published");
    expect(w.state.drive).toMatchObject({ url: URL, code: "CODE1XYZ", issuedBy: "device-self-01" });
    expect(await w.auto.run()).toBe("fresh");
    expect(w.state.requested).toBe(1);

    // 剩余时间低于阈值就换新的；过期的也换。
    w.advance(10 * MIN - INVITE_REFRESH_BEFORE_MS + 1);
    expect(await w.auto.run()).toBe("published");
    expect(w.state.drive?.code).toBe("CODE2XYZ");
    w.advance(11 * MIN);
    expect(await w.auto.run()).toBe("published");
    expect(w.state.requested).toBe(3);
  });

  it("云盘里的邀请码指向别的中转时换成本机中转的", async () => {
    const w = world({
      enrolled: true,
      drive: { url: "https://old.example.com", code: "OLDCODE12", expiresAt: new Date(1_000_000 + 9 * MIN).toISOString(), issuedBy: "other" },
    });
    expect(await w.auto.run()).toBe("published");
    expect(w.state.drive?.url).toBe(URL);
  });

  it("没入网的设备读到云盘里的邀请码就自动入网", async () => {
    const w = world({
      drive: { url: URL, code: "GOODCODE1", expiresAt: new Date(1_000_000 + 5 * MIN).toISOString(), issuedBy: "device-vps" },
    });
    expect(await w.auto.run()).toBe("joined");
    expect(w.state.joined).toEqual([[URL, "GOODCODE1"]]);
  });

  it("云盘里没有邀请码、或已过期：等着，不乱兑换", async () => {
    const none = world();
    expect(await none.auto.run()).toBe("waiting");
    expect(none.state.joined).toEqual([]);

    const expired = world({
      drive: { url: URL, code: "OLDCODE12", expiresAt: new Date(1_000_000 - MIN).toISOString(), issuedBy: "x" },
    });
    expect(await expired.auto.run()).toBe("waiting");
    expect(expired.state.joined).toEqual([]);
  });

  it("兑换失败后同一个码不再试，换了新码再试", async () => {
    let fail = true;
    const w = world({
      drive: { url: URL, code: "USEDCODE1", expiresAt: new Date(1_000_000 + 5 * MIN).toISOString(), issuedBy: "x" },
      join: async () => {
        if (fail) throw new Error("邀请码无效");
      },
    });
    expect(await w.auto.run()).toBe("failed");
    expect(await w.auto.run()).toBe("waiting");
    fail = false;
    w.state.drive = { url: URL, code: "NEWCODE12", expiresAt: new Date(1_000_000 + 8 * MIN).toISOString(), issuedBy: "x" };
    expect(await w.auto.run()).toBe("joined");
  });

  it("不能入网的设备（比如在用自己的 Bot Token 直连）什么都不做", async () => {
    const w = world({
      canJoin: async () => false,
      drive: { url: URL, code: "GOODCODE1", expiresAt: new Date(1_000_000 + 5 * MIN).toISOString(), issuedBy: "x" },
    });
    expect(await w.auto.run()).toBe("skipped");
  });

  it("本机经回环地址连中转（VPS 上的 daemon）：云盘里写中转返回的公网地址，且不会每次心跳都换新码", async () => {
    const w = world({
      enrolledUrl: async () => "http://127.0.0.1:8787",
      requestInvite: async () => {
        w.state.requested += 1;
        return { url: URL, code: `CODE${w.state.requested}XYZ`, expiresAt: new Date(w.now() + 10 * MIN).toISOString() };
      },
    });
    expect(await w.auto.run()).toBe("published");
    expect(w.state.drive?.url).toBe(URL);
    expect(await w.auto.run()).toBe("fresh");
    expect(w.state.requested).toBe(1);
  });

  it("中转没给公网地址、只有回环地址时不往云盘写（别的设备连不上）", async () => {
    const w = world({
      enrolledUrl: async () => "http://127.0.0.1:8787",
      requestInvite: async () => ({ url: "http://127.0.0.1:8787", code: "LOOPCODE1", expiresAt: new Date(w.now() + 10 * MIN).toISOString() }),
    });
    expect(await w.auto.run()).toBe("skipped");
    expect(w.state.drive).toBeNull();
  });

  it("云盘里的邀请码是回环地址（旧版 VPS 写的）：不去兑换，继续等", async () => {
    for (const url of ["http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787"]) {
      const w = world({
        drive: { url, code: "LOOPCODE1", expiresAt: new Date(1_000_000 + 5 * MIN).toISOString(), issuedBy: "device-vps" },
      });
      expect(await w.auto.run()).toBe("waiting");
      expect(w.state.joined).toEqual([]);
    }
  });

  it("申请或写云盘出错只返回 failed，不抛出", async () => {
    const w = world({ enrolled: true, requestInvite: async () => Promise.reject(new Error("中转不通")) });
    expect(await w.auto.run()).toBe("failed");
  });
});
