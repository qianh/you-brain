export interface InlineNode {
  kind: "text" | "strong" | "em" | "code" | "link";
  text: string;
  href?: string;
}

export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "rule" };

export function isSafeHref(href: string): boolean {
  return href.startsWith("https://") || href.startsWith("http://") || href.startsWith("mailto:");
}

export function parseInline(input: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buffer = "";
  let index = 0;
  const flush = (): void => {
    if (buffer === "") return;
    nodes.push({ kind: "text", text: buffer });
    buffer = "";
  };
  while (index < input.length) {
    if (input.startsWith("**", index)) {
      const end = input.indexOf("**", index + 2);
      if (end > index + 2) {
        flush();
        nodes.push({ kind: "strong", text: input.slice(index + 2, end) });
        index = end + 2;
        continue;
      }
    }
    const current = input[index] ?? "";
    if (current === "`") {
      const end = input.indexOf("`", index + 1);
      if (end > index) {
        flush();
        nodes.push({ kind: "code", text: input.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }
    if (current === "[") {
      const close = input.indexOf("]", index + 1);
      if (close > index && input[close + 1] === "(") {
        const end = input.indexOf(")", close + 2);
        const href = end > close ? input.slice(close + 2, end).trim() : "";
        if (end > close && isSafeHref(href)) {
          flush();
          nodes.push({ kind: "link", text: input.slice(index + 1, close), href });
          index = end + 1;
          continue;
        }
      }
    }
    if (current === "*" && input[index + 1] !== "*") {
      const end = input.indexOf("*", index + 1);
      if (end > index + 1) {
        flush();
        nodes.push({ kind: "em", text: input.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }
    buffer += current;
    index += 1;
  }
  flush();
  return nodes;
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (/^(-{3,}|\*{3,})$/u.test(line.trim())) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading) {
      const marks = heading[1] ?? "#";
      const level = marks.length === 1 ? 1 : marks.length === 2 ? 2 : 3;
      blocks.push({ kind: "heading", level, text: (heading[2] ?? "").trim() });
      index += 1;
      continue;
    }
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith(">")) {
        body.push((lines[index] ?? "").replace(/^>\s?/u, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    if (/^\s*[-*]\s+/u.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/u.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\s*[-*]\s+/u, ""));
        index += 1;
      }
      blocks.push({ kind: "list", ordered: false, items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/u.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/u.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\s*\d+[.)]\s+/u, ""));
        index += 1;
      }
      blocks.push({ kind: "list", ordered: true, items });
      continue;
    }
    const body: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (next.trim() === "") break;
      if (
        next.startsWith("```") ||
        next.startsWith(">") ||
        /^(#{1,3})\s+/u.test(next) ||
        /^\s*[-*]\s+/u.test(next) ||
        /^\s*\d+[.)]\s+/u.test(next) ||
        /^(-{3,}|\*{3,})$/u.test(next.trim())
      ) {
        break;
      }
      body.push(next);
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: body.join(" ") });
  }
  return blocks;
}
