import type { DaemonChangeKind, DaemonEvent } from "./types.js";

/** In-process fan-out for SSE. The daemon publishes after background refreshes. */
export class ChangeHub {
  #listeners = new Set<(event: DaemonEvent) => void>();
  #shutdown = new Set<() => void>();
  #seq = 0;

  publish(kind: DaemonChangeKind, at = new Date().toISOString()): DaemonEvent {
    const event: DaemonEvent = { id: ++this.#seq, kind, at };
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        this.#listeners.delete(listener);
      }
    }
    return event;
  }

  subscribe(listener: (event: DaemonEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** SSE responses register here so shutdown can end the stream without the client. */
  onShutdown(fn: () => void): () => void {
    this.#shutdown.add(fn);
    return () => {
      this.#shutdown.delete(fn);
    };
  }

  shutdown(): void {
    const closers = [...this.#shutdown];
    this.#shutdown.clear();
    this.#listeners.clear();
    for (const close of closers) {
      try {
        close();
      } catch {
        // One stuck stream must not block the others.
      }
    }
  }

  /** SSE clients currently attached. The daemon pulls faster while this is non-zero. */
  subscriberCount(): number {
    return this.#listeners.size;
  }
}

export function formatSse(event: DaemonEvent): string {
  return `id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}
