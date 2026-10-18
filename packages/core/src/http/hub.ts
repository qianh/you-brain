import type { DaemonChangeKind, DaemonEvent } from "./types.js";

/** In-process fan-out for SSE. The daemon publishes after background refreshes. */
export class ChangeHub {
  #listeners = new Set<(event: DaemonEvent) => void>();
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

  /** SSE clients currently attached. The daemon pulls faster while this is non-zero. */
  subscriberCount(): number {
    return this.#listeners.size;
  }
}

export function formatSse(event: DaemonEvent): string {
  return `id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}
