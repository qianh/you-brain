export interface OutputTimer {
  cancel(): void;
}

export interface OutputClock {
  now(): Date;
  schedule(ms: number, fn: () => void): OutputTimer;
}

interface PendingTimer {
  at: number;
  fn: () => void;
}

export class ManualClock implements OutputClock {
  #nowMs: number;
  #nextId = 1;
  readonly #timers = new Map<number, PendingTimer>();

  constructor(now: Date) {
    this.#nowMs = now.getTime();
  }

  now(): Date {
    return new Date(this.#nowMs);
  }

  schedule(ms: number, fn: () => void): OutputTimer {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#timers.set(id, { at: this.#nowMs + ms, fn });
    return {
      cancel: () => {
        this.#timers.delete(id);
      },
    };
  }

  advance(ms: number): void {
    const target = this.#nowMs + ms;
    while (true) {
      let next: { id: number; at: number; fn: () => void } | null = null;
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
      this.#nowMs = next.at;
      this.#timers.delete(next.id);
      next.fn();
    }
    this.#nowMs = target;
  }
}

export function systemClock(): OutputClock {
  return {
    now: () => new Date(),
    schedule(ms, fn) {
      const handle = setTimeout(fn, ms);
      return {
        cancel: () => {
          clearTimeout(handle);
        },
      };
    },
  };
}
