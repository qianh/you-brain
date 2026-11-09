/**
 * 粘贴网页/文档的富文本(text/html)→ Markdown,再交给 parseMarkdownBlocks 拆块。
 * 只在 HTML 真有块结构(标题、列表、表格、引用、代码、图片、多段)时才用,
 * 否则按纯文本粘贴(VS Code 等编辑器复制的 HTML 只是带样式的 div)。
 */

const BLOCK_TAGS = /<(h[1-6]|ul|ol|li|table|blockquote|pre|img|hr)\b/iu;

export function isStructuredHtml(html: string): boolean {
  if (BLOCK_TAGS.test(html)) return true;
  return (html.match(/<p\b/giu)?.length ?? 0) >= 2;
}

function escapeInline(text: string): string {
  return text.replace(/([*_`~[\]])/gu, "\\$1");
}

function inline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeInline((node.textContent ?? "").replace(/\s+/gu, " "));
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  const inner = (): string => Array.from(element.childNodes).map(inline).join("");
  const style = element.getAttribute("style") ?? "";
  switch (tag) {
    case "br":
      return "<br>";
    case "strong":
    case "b": {
      // Google Docs 用 <b style="font-weight:normal"> 包整段,不是真的粗体。
      if (/font-weight\s*:\s*(normal|400)/iu.test(style)) return inner();
      const text = inner();
      return text.trim() === "" ? text : `**${text}**`;
    }
    case "em":
    case "i": {
      const text = inner();
      return text.trim() === "" ? text : `*${text}*`;
    }
    case "s":
    case "del":
    case "strike": {
      const text = inner();
      return text.trim() === "" ? text : `~~${text}~~`;
    }
    case "code":
      return `\`${element.textContent ?? ""}\``;
    case "a": {
      const href = element.getAttribute("href") ?? "";
      const text = inner();
      return /^https?:|^mailto:/iu.test(href) && text.trim() !== "" ? `[${text}](${href})` : text;
    }
    case "img": {
      const src = element.getAttribute("src") ?? "";
      return /^https?:/iu.test(src) ? `\n![${element.getAttribute("alt") ?? ""}](${src})\n` : "";
    }
    case "span": {
      let text = inner();
      if (/font-weight\s*:\s*(bold|[6-9]00)/iu.test(style) && text.trim() !== "") text = `**${text}**`;
      if (/font-style\s*:\s*italic/iu.test(style) && text.trim() !== "") text = `*${text}*`;
      return text;
    }
    case "script":
    case "style":
    case "meta":
    case "link":
      return "";
    default:
      return inner();
  }
}

function cellText(cell: Element): string {
  return Array.from(cell.childNodes)
    .map((child) => (child.nodeType === Node.ELEMENT_NODE && /^(p|div)$/iu.test((child as Element).tagName) ? `${inline(child)}<br>` : inline(child)))
    .join("")
    .replace(/(<br>)+$/u, "")
    .replace(/\|/gu, "\\|")
    .trim();
}

function blocks(node: Node, depth: number, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? "").trim();
    if (text !== "") out.push(escapeInline(text));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  const indent = "  ".repeat(depth);
  const children = (): void => {
    for (const child of Array.from(element.childNodes)) blocks(child, depth, out);
  };
  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Math.min(4, Number(tag[1]));
      out.push(`${"#".repeat(level)} ${inline(element).trim()}`);
      return;
    }
    case "p": {
      const text = inline(element).trim();
      if (text !== "") out.push(...text.split(/\n+/u).map((line) => indent + line.trim()).filter((line) => line.trim() !== ""));
      return;
    }
    case "ul":
    case "ol": {
      let number = 0;
      for (const item of Array.from(element.children)) {
        if (item.tagName.toLowerCase() !== "li") {
          blocks(item, depth + 1, out);
          continue;
        }
        number += 1;
        const checkbox = item.querySelector(":scope > input[type=checkbox]") as HTMLInputElement | null;
        const own: string[] = [];
        const nested: Element[] = [];
        for (const child of Array.from(item.childNodes)) {
          if (child.nodeType === Node.ELEMENT_NODE && /^(ul|ol)$/iu.test((child as Element).tagName)) nested.push(child as Element);
          else if (child !== checkbox) own.push(inline(child));
        }
        const text = own.join("").replace(/\s+/gu, " ").trim();
        const marker = checkbox ? `- [${checkbox.checked ? "x" : " "}]` : tag === "ol" ? `${number}.` : "-";
        out.push(`${indent}${marker} ${text}`);
        for (const list of nested) blocks(list, depth + 1, out);
      }
      return;
    }
    case "blockquote": {
      const inner: string[] = [];
      for (const child of Array.from(element.childNodes)) blocks(child, 0, inner);
      for (const line of inner) out.push(`> ${line}`);
      return;
    }
    case "pre": {
      const code = element.querySelector("code");
      const language = /language-([\w+#-]+)/u.exec(code?.className ?? "")?.[1] ?? "";
      out.push("```" + language, (element.textContent ?? "").replace(/\n$/u, ""), "```");
      return;
    }
    case "hr":
      out.push("---");
      return;
    case "img": {
      const src = element.getAttribute("src") ?? "";
      if (/^https?:/iu.test(src)) out.push(`![${element.getAttribute("alt") ?? ""}](${src})`);
      return;
    }
    case "table": {
      const rows = Array.from(element.querySelectorAll("tr"));
      if (rows.length === 0) return;
      const cells = rows.map((row) => Array.from(row.children).map(cellText));
      const width = Math.max(...cells.map((row) => row.length));
      cells.forEach((row, index) => {
        const padded = [...row, ...Array.from({ length: width - row.length }, () => "")];
        out.push(`| ${padded.join(" | ")} |`);
        if (index === 0) out.push(`|${padded.map(() => " --- ").join("|")}|`);
      });
      return;
    }
    case "br":
      return;
    case "div":
    case "section":
    case "article":
    case "main":
    case "body":
    case "span":
    case "b":
    case "figure":
    case "details":
    case "summary": {
      // 容器:里面有块就递归,纯行内内容当成一段。
      const hasBlocks = Array.from(element.children).some((child) => /^(h[1-6]|p|ul|ol|table|blockquote|pre|hr|div|img|figure|section)$/iu.test(child.tagName));
      if (hasBlocks) children();
      else {
        const text = inline(element).trim();
        if (text !== "") out.push(indent + text);
      }
      return;
    }
    case "script":
    case "style":
    case "meta":
    case "title":
      return;
    default: {
      const text = inline(element).trim();
      if (text !== "") out.push(indent + text);
    }
  }
}

/** HTML → Markdown(按块一行一个,行内保留粗体/斜体/删除线/代码/链接)。 */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: string[] = [];
  for (const child of Array.from(doc.body.childNodes)) blocks(child, 0, out);
  return out
    // 表格单元格里的 <br> 由表格解析转成格内换行;其余行的换行并成空格。
    .map((line) => (line.trimStart().startsWith("|") ? line : line.replace(/<br>/gu, " ")).replace(/[ \t]+$/u, ""))
    .join("\n");
}
