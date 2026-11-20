import { describe, expect, test } from "bun:test";

import { createBatchedTerminalOutput, mergeTerminalOutput } from "../../src/pages/deck-terminal-output.js";

describe("mergeTerminalOutput", () => {
  test("空输入返回空数组", () => {
    expect(mergeTerminalOutput([])).toEqual(new Uint8Array(0));
  });

  test("单块原样返回", () => {
    const one = new Uint8Array([1, 2, 3]);
    expect(mergeTerminalOutput([one])).toBe(one);
  });

  test("多块按序拼接", () => {
    expect([...mergeTerminalOutput([new Uint8Array([1]), new Uint8Array([2, 3])])]).toEqual([1, 2, 3]);
  });
});

describe("createBatchedTerminalOutput", () => {
  test("控制任务会先刷完已攒的二进制", async () => {
    globalThis.requestAnimationFrame = (cb) => {
      cb(0);
      return 1;
    };
    globalThis.cancelAnimationFrame = () => undefined;
    const writes: number[] = [];
    const order: string[] = [];
    const batch = createBatchedTerminalOutput(
      {
        writeBinary(bytes, done) {
          writes.push(bytes.length);
          order.push("write");
          done();
        },
        ack() {
          order.push("ack");
        },
      },
      () => false,
    );
    batch.pushBinary(new Uint8Array([1, 2]));
    batch.enqueue(async () => {
      order.push("control");
    });
    batch.flushPendingSync();
    await batch.whenIdle();
    expect(writes).toEqual([2]);
    expect(order).toEqual(["write", "ack", "control"]);
  });

  test("暂存期间收到即 ACK、不写入，关闭后一次写完且不重复 ACK", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb) => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;
    const writes: number[][] = [];
    const acks: number[] = [];
    const batch = createBatchedTerminalOutput(
      {
        writeBinary(bytes, done) {
          writes.push([...bytes]);
          done();
        },
        ack(bytes) {
          acks.push(bytes);
        },
      },
      () => false,
    );
    batch.setHolding(true);
    batch.pushBinary(new Uint8Array([1, 2]));
    batch.pushBinary(new Uint8Array([3]));
    expect(frames).toHaveLength(0);
    expect(writes).toEqual([]);
    expect(acks).toEqual([2, 1]);
    batch.setHolding(false);
    batch.pushBinary(new Uint8Array([4]));
    await batch.whenIdle();
    expect(writes).toEqual([[1, 2, 3, 4]]);
    expect(acks).toEqual([2, 1, 1]);
  });
});
