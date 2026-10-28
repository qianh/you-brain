import type { NotionSegment } from "./model.js";

/**
 * Minimal markdown round-trip for editing one block's rich text.
 *
 * Covered inline syntax: `code`, **bold**, *italic*, ~~strike~~,
 * [text](url). Underline and colors have no markdown form — an edit of the
 * block rewrites its segments, so those two degrade to plain text. Fine for
 * v1: they are rare in practice and Notion still renders everything else.
 */

export function segmentsToMarkdown(segments: readonly NotionSegment[]): string {
  let out = "";
  for (const segment of segments) {
    let text = segment.text;
    if (segment.code) text = `\`${text}\``;
    if (segment.bold) text = `**${text}**`;
    if (segment.italic) text = `*${text}*`;
    if (segment.strikethrough) text = `~~${text}~~`;
    if (segment.href) text = `[${text}](${segment.href})`;
    out += text;
  }
  return out;
}

interface Mark {
  at: number;
  len: number;
  kind: "code" | "bold" | "italic" | "strike" | "link";
  href?: string;
}

export function markdownToSegments(markdown: string): NotionSegment[] {
  // Find the earliest inline marker; text before it is plain.
  const segments: NotionSegment[] = [];
  let rest = markdown;
  while (rest.length > 0) {
    const mark = nextMark(rest);
    if (!mark) {
      pushPlain(segments, rest);
      break;
    }
    if (mark.at > 0) pushPlain(segments, rest.slice(0, mark.at));
    const closer = rest.indexOf(closerFor(mark), mark.at + mark.len);
    if (closer < 0) {
      // Unterminated marker: the marker itself and the tail are plain text.
      pushPlain(segments, rest.slice(mark.at));
      break;
    }
    const inner = rest.slice(mark.at + mark.len, closer);
    let after = rest.slice(closer + closerFor(mark).length);
    let href = mark.href ?? null;
    if (mark.kind === "link" && after.startsWith("(")) {
      const closeParen = after.indexOf(")");
      if (closeParen > 0) {
        href = after.slice(1, closeParen);
        after = after.slice(closeParen + 1);
      }
    }
    segments.push({
      text: inner,
      href,
      bold: mark.kind === "bold",
      italic: mark.kind === "italic",
      strikethrough: mark.kind === "strike",
      underline: false,
      code: mark.kind === "code",
      color: "default",
    });
    rest = after;
  }
  return segments;
}

function nextMark(text: string): Mark | null {
  const candidates: Mark[] = [];
  const scan = (token: string, kind: Mark["kind"], minRemaining: number): void => {
    const at = text.indexOf(token);
    if (at >= 0 && text.length - at > minRemaining) {
      candidates.push({ at, len: token.length, kind });
    }
  };
  scan("`", "code", 1);
  scan("**", "bold", 3);
  scan("~~", "strike", 3);
  scan("[", "link", 2);
  const single = earliestValidItalic(text);
  if (single) candidates.push(single);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.at - b.at || b.len - a.len);
  return candidates[0] ?? null;
}

/**
 * A lone `*` counts as italic only when a closing lone `*` exists and neither
 * star belongs to a `**` pair — `3 * 4 = 12,而 **真粗体**` must keep its star.
 */
function earliestValidItalic(text: string): Mark | null {
  let open = 0;
  while (true) {
    const at = text.indexOf("*", open);
    if (at < 0) return null;
    open = at + 1;
    const prev = text[at - 1] ?? "";
    const next = text[at + 1] ?? "";
    if (prev === "*" || next === "*") continue;
    let closer = text.indexOf("*", at + 1);
    let valid = false;
    while (closer >= 0) {
      const closerNext = text[closer + 1] ?? "";
      const closerPrev = text[closer - 1] ?? "";
      if (closerNext !== "*" && closerPrev !== "*") {
        valid = true;
        break;
      }
      closer = text.indexOf("*", closer + 1);
    }
    if (valid) return { at, len: 1, kind: "italic" };
  }
}

function closerFor(mark: Mark): string {
  switch (mark.kind) {
    case "code":
      return "`";
    case "bold":
      return "**";
    case "italic":
      return "*";
    case "strike":
      return "~~";
    case "link":
      return "]";
  }
}

function pushPlain(segments: NotionSegment[], text: string): void {
  if (text === "") return;
  const last = segments[segments.length - 1];
  if (last && !last.bold && !last.italic && !last.code && !last.strikethrough && last.href === null) {
    last.text += text;
    return;
  }
  segments.push({
    text,
    href: null,
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
  });
}
