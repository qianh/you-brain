import { describe, expect, test } from "bun:test";

import { verifyCommand, type CommandSigningFields } from "@you-brain/protocol";

import { MemorySecretStore } from "../../src/auth/secret-store.js";
import { DeviceIdentity } from "../../src/dispatch/index.js";

describe("DeviceIdentity", () => {
  test("首次生成密钥并写入 store，再次读取返回同一把密钥", async () => {
    const store = new MemorySecretStore(null);
    const first = new DeviceIdentity({ store });
    const created = await first.ensure();

    expect(created.publicKey.length).toBeGreaterThan(20);
    expect(created.privateKey.length).toBeGreaterThan(20);
    expect(await store.get()).toBe(created.privateKey);
    expect(await first.publicKey()).toBe(created.publicKey);

    // 重新构造实例：从同一个 store 读回并推导出同一公钥，不重新生成。
    const second = new DeviceIdentity({ store });
    const loaded = await second.ensure();
    expect(loaded).toEqual(created);
    expect(await second.publicKey()).toBe(created.publicKey);

    const fields: CommandSigningFields = {
      cmdId: "c-1",
      from: "dev-a",
      to: "dev-b",
      ts: 1_760_000_000_000,
      nonce: "nonce-1",
      cmd: { kind: "t3.projects", args: {} },
    };
    const sig = await second.sign(fields);
    expect(verifyCommand(loaded.publicKey, { ...fields, sig })).toBe(true);
  });

  test("并发调用 ensure 只生成并持久化同一把密钥", async () => {
    const store = new MemorySecretStore(null);
    const identity = new DeviceIdentity({ store });
    const [a, b] = await Promise.all([identity.ensure(), identity.ensure()]);
    expect(a).toEqual(b);
    expect(await store.get()).toBe(a.privateKey);
  });

  test("已存私钥损坏时抛中文错误、不覆盖原值、错误信息不含原值", async () => {
    const corrupted = "CORRUPTED_SECRET_VALUE_xyz123";
    const store = new MemorySecretStore(corrupted);
    const identity = new DeviceIdentity({ store });

    let caught: Error | null = null;
    try {
      await identity.ensure();
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("损坏");
    expect(caught!.message).not.toContain(corrupted);
    // 绝不悄悄覆盖
    expect(await store.get()).toBe(corrupted);

    await expect(identity.publicKey()).rejects.toThrow("损坏");
    await expect(
      identity.sign({
        cmdId: "c-1",
        from: "a",
        to: "b",
        ts: 1,
        nonce: "n",
        cmd: { kind: "t3.projects", args: {} },
      }),
    ).rejects.toThrow("损坏");
    expect(await store.get()).toBe(corrupted);
  });
});
