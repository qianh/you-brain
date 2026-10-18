export interface DaemonTimer {
  cancel(): void;
}

/** Clock shared by the scheduler, output debounce, and protocol timestamps. */
export interface DaemonClock {
  now(): Date;
  nowMs(): number;
  schedule(ms: number, fn: () => void | Promise<void>): DaemonTimer;
}

interface PendingTimer {
  at: number;
  fn: () => void | Promise<void>;
}

/**
 * Virtual clock. `advance` awaits each timer, then keeps going so a timer
 * armed during that callback still fires when its time is inside the window.
 * Equal timestamps run in schedule order.
 */
export class ManualDaemonClock implements DaemonClock {
  #now: number;
  #nextId = 1;
  readonly #timers = new Map<number, PendingTimer>();

  constructor(now: Date) {
    this.#now = now.getTime();
  }

  now(): Date {
    return new Date(this.#now);
  }

  nowMs(): number {
    return this.#now;
  }

  schedule(ms: number, fn: () => void | Promise<void>): DaemonTimer {
    const id = this.#nextId;
    this.#nextId += 1;
    const delay = Math.max(1, ms);
    this.#timers.set(id, { at: this.#now + delay, fn });
    return {
      cancel: () => {
        this.#timers.delete(id);
      },
    };
  }

  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    while (true) {
      let next: { id: number; at: number; fn: PendingTimer["fn"] } | null = null;
      for (const [id, timer] of this.#timers) {
        if (timer.at > target) continue;
        if (
          next === null ||
          timer.at < next.at ||
          (timer.at === next.at && id < next.id)
        ) {
          next = { id, at: timer.at, fn: timer.fn };
        }
      }
      if (!next) break;
      this.#timers.delete(next.id);
      this.#now = next.at;
      await next.fn();
    }
    this.#now = target;
  }
}

export function systemDaemonClock(): DaemonClock {
  return {
    now() {
      return new Date();
    },
    nowMs() {
      return Date.now();
    },
    schedule(ms, fn) {
      const handle = setTimeout(() => {
        void fn();
      }, Math.max(1, ms));
      return {
        cancel: () => {
          clearTimeout(handle);
        },
      };
    },
  };
}
