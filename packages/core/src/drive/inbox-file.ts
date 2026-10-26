import { posix } from "node:path";

/**
 * True for a file under `inbox/` that holds a whole session: markdown, and not a
 * half-written temporary file.
 *
 * The browser plugin writes the body first and renames it into place, so a partial
 * upload can sit in Drive as `.2b4660d0-….tmp` — with `text/markdown` as its declared
 * type, which made a type-only check accept it as a session. It carries the same
 * `conversation_id` as the finished file, so accepting it also produced a phantom
 * second "session" for one conversation.
 */
export function isInboxSessionFile(input: { path: string; mimeType?: string | null }): boolean {
  if (!input.path.startsWith("inbox/")) return false;
  const name = posix.basename(input.path);
  if (name.startsWith(".")) return false;
  if (name.endsWith(".tmp")) return false;
  return name.endsWith(".md") || input.mimeType === "text/markdown";
}
