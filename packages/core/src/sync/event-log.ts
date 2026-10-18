import { createEvent, ulid, type EventOf, type EventType } from "@you-brain/protocol";

import { YouBrainError } from "../domain/errors.js";
import { seqCursorKey } from "./cursors.js";

export interface EventLogStore {
  getCursor(key: string): string | null;
  setCursor(key: string, value: string): void;
}

export interface EventLogOptions {
  now?: () => Date;
  ulid?: (timestamp: number) => string;
}

export interface AllocateOptions {
  ts?: string;
}

/**
 * Local event factory. Sequence numbers are per device and survive restarts
 * in the store cursor table.
 */
export class EventLog {
  readonly #store: EventLogStore;
  readonly #deviceId: string;
  readonly #now: () => Date;
  readonly #ulid: (timestamp: number) => string;
  readonly #seqKey: string;

  constructor(store: EventLogStore, deviceId: string, options: EventLogOptions = {}) {
    if (deviceId.length === 0) {
      throw new YouBrainError("INVALID_INPUT", "deviceId is required");
    }
    this.#store = store;
    this.#deviceId = deviceId;
    this.#now = options.now ?? (() => new Date());
    this.#ulid = options.ulid ?? ulid;
    this.#seqKey = seqCursorKey(deviceId);
  }

  allocate<T extends EventType>(
    type: T,
    data: EventOf<T>["data"],
    options: AllocateOptions = {},
  ): EventOf<T> {
    const ts = options.ts ?? this.#now().toISOString();
    const timestamp = Date.parse(ts);
    if (Number.isNaN(timestamp)) {
      throw new YouBrainError("INVALID_INPUT", "Event timestamp must be ISO-8601");
    }
    const seq = this.#nextSeq();
    const event = createEvent({
      type,
      data,
      device: this.#deviceId,
      ts,
      seq,
      id: this.#ulid(timestamp),
    });
    this.#store.setCursor(this.#seqKey, String(seq));
    return event;
  }

  #nextSeq(): number {
    const raw = this.#store.getCursor(this.#seqKey);
    if (raw === null) return 1;
    const last = Number(raw);
    if (!Number.isSafeInteger(last) || last < 0) {
      throw new YouBrainError("INVALID_INPUT", "Event sequence cursor is invalid");
    }
    return last + 1;
  }
}
