/**
 * tty7 终端输出渲染：二进制回放按帧合并写入，控制类 JSON 仍按顺序排在合并块之后。
 * resize/ready 等控制消息与 xterm 的 write 队列顺序由 deck-tty7-terminal 保证。
 */

export function mergeTerminalOutput(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export interface TerminalOutputSink {
  writeBinary(bytes: Uint8Array, onComplete: () => void): void;
  ack(bytes: number): void;
}

/**
 * 把连续到达的二进制帧攒到下一帧再一次性 terminal.write，减轻回放时卡顿。
 * 控制任务走 enqueue，会先把未刷新的二进制同步写完再执行。
 * `setHolding(true)` 时不按帧写入，先全部攒着（收到即 ACK，daemon 不会因此暂停），
 * 关掉或遇到控制任务时一次写完；用于回放历史时不让 xterm 逐帧重画。
 */
export function createBatchedTerminalOutput(
  sink: TerminalOutputSink,
  isDisposed: () => boolean,
): {
  pushBinary(bytes: Uint8Array): void;
  enqueue(task: () => void | Promise<void>): void;
  flushPendingSync(): void;
  whenIdle(): Promise<void>;
  setHolding(holding: boolean): void;
} {
  let chain: Promise<void> = Promise.resolve();
  let pending: Uint8Array[] = [];
  let raf = 0;
  let holding = false;
  /** pending 里已经 ACK 过的字节数（暂存期间收到即 ACK）。 */
  let preAcked = 0;

  const flushSync = (): void => {
    if (pending.length === 0) return;
    const bytes = mergeTerminalOutput(pending);
    pending = [];
    const toAck = bytes.length - preAcked;
    preAcked = 0;
    if (isDisposed()) return;
    chain = chain.then(
      () =>
        new Promise<void>((resolve) => {
          if (isDisposed()) {
            resolve();
            return;
          }
          sink.writeBinary(bytes, () => {
            resolve();
          });
          if (toAck > 0) sink.ack(toAck);
        }),
    );
  };

  const scheduleFlush = (): void => {
    if (raf !== 0) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      flushSync();
    });
  };

  return {
    pushBinary(bytes: Uint8Array) {
      if (bytes.length === 0 || isDisposed()) return;
      pending.push(bytes);
      if (holding) {
        preAcked += bytes.length;
        sink.ack(bytes.length);
        return;
      }
      scheduleFlush();
    },
    setHolding(next) {
      holding = next;
      if (!next && pending.length > 0) scheduleFlush();
    },
    flushPendingSync() {
      if (raf !== 0) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      flushSync();
    },
    enqueue(task) {
      this.flushPendingSync();
      chain = chain
        .then(async () => {
          if (isDisposed()) return;
          await task();
        })
        .catch(() => undefined);
    },
    whenIdle() {
      this.flushPendingSync();
      return chain;
    },
  };
}
