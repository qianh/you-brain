import { createEvent } from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import { foldEventsCached } from "../../src/topics/book-cache.js";
import { foldEvents } from "../../src/topics/fold.js";

const created = (seq: number, ts: string, name: string) =>
  createEvent({ type: "topic.created", data: { topicId: `t-${seq}`, name, aliases: [] }, device: "dev-a", ts, seq });
const renamed = (seq: number, ts: string, topicId: string, name: string) =>
  createEvent({ type: "topic.renamed", data: { topicId, name, aliases: [] }, device: "dev-a", ts, seq });

const view = (book: ReturnType<typeof foldEvents>) => ({
  topics: book.topics, sessions: book.sessions, conclusions: book.conclusions, todos: book.todos,
});

describe("foldEventsCached", () => {
  const first = created(1, "2026-07-01T00:00:00.000Z", "Alpha");
  const second = renamed(2, "2026-07-03T00:00:00.000Z", "t-1", "Gamma");

  it("matches a full fold when events are appended, and reuses an unchanged list", () => {
    const base = [first];
    const book = foldEventsCached(base);
    expect(foldEventsCached([first])).toBe(book);
    const grown = [first, second];
    expect(view(foldEventsCached(grown))).toEqual(view(foldEvents(grown)));
    expect(foldEventsCached(grown).topics[0]?.name).toBe("Gamma");
  });

  it("matches a full fold when a new event sorts before the last one", () => {
    foldEventsCached([first, second]);
    // Pulled from another device: older than `second`, appended after it in the list.
    const earlier = renamed(3, "2026-07-02T00:00:00.000Z", "t-1", "Beta");
    const list = [first, second, earlier];
    const book = foldEventsCached(list);
    expect(view(book)).toEqual(view(foldEvents(list)));
    expect(book.topics[0]?.name).toBe("Gamma");
  });

  it("folds from scratch for an unrelated list", () => {
    foldEventsCached([first, second]);
    const other = [created(9, "2026-07-05T00:00:00.000Z", "Other")];
    expect(view(foldEventsCached(other))).toEqual(view(foldEvents(other)));
  });
});
