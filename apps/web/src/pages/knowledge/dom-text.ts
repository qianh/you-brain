import type { NotionSegment } from "@you-brain/core/http/types.js";

/**
 * 所见即所得编辑的 DOM 层:富文本段落 ↔ contentEditable 内容,
 * 以及光标在纯文本偏移上的定位工具。
 *
 * 支持的行内标签与 core 的 markdown-text 同一集合:
 * b/strong、i/em、u、s/strike/del、code、a[href]。
 */

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function segmentsToHtml(segments: readonly NotionSegment[]): string {
  const html = segmentsToHtmlRaw(segments);
  // 文本以软换行结尾时,末尾的 <br> 会被浏览器折叠,补一个占位 br 才能看见新行。
  return segments[segments.length - 1]?.text.endsWith("\n") ? `${html}<br>` : html;
}

function segmentsToHtmlRaw(segments: readonly NotionSegment[]): string {
  return segments
    .map((segment) => {
      let html = escapeHtml(segment.text).replaceAll("\n", "<br>");
      if (segment.code) html = `<code>${html}</code>`;
      if (segment.bold) html = `<b>${html}</b>`;
      if (segment.italic) html = `<i>${html}</i>`;
      if (segment.underline) html = `<u>${html}</u>`;
      if (segment.strikethrough) html = `<s>${html}</s>`;
      if (segment.href) html = `<a href="${escapeHtml(segment.href)}">${html}</a>`;
      return html;
    })
    .join("");
}

interface FormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  code: boolean;
  href: string | null;
}

function domToSegmentsImpl(
  node: Node,
  state: FormatState,
  out: NotionSegment[],
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    if (text === "") return;
    const last = out[out.length - 1];
    if (
      last &&
      last.bold === state.bold &&
      last.italic === state.italic &&
      last.underline === state.underline &&
      last.strikethrough === state.strikethrough &&
      last.code === state.code &&
      last.href === state.href
    ) {
      last.text += text;
      return;
    }
    out.push({
      text,
      href: state.href,
      bold: state.bold,
      italic: state.italic,
      strikethrough: state.strikethrough,
      underline: state.underline,
      code: state.code,
      color: "default",
    });
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (tag === "br") {
    // Shift+Enter 的软换行;末尾那个占位 br 在 domToSegments 里统一扣掉。
    domToSegmentsImpl(document.createTextNode("\n"), state, out);
    return;
  }
  const next: FormatState = { ...state };
  if (tag === "b" || tag === "strong") next.bold = true;
  else if (tag === "i" || tag === "em") next.italic = true;
  else if (tag === "u") next.underline = true;
  else if (tag === "s" || tag === "strike" || tag === "del") next.strikethrough = true;
  else if (tag === "code") next.code = true;
  else if (tag === "a") next.href = element.getAttribute("href");
  for (const child of Array.from(element.childNodes)) {
    domToSegmentsImpl(child, next, out);
  }
}

function lastLeaf(node: Node): Node {
  let current = node;
  while (current.lastChild) current = current.lastChild;
  return current;
}

export function domToSegments(element: readonly Node[] | Node): NotionSegment[] {
  const root = element instanceof Node ? element : wrapNodes(element);
  const out: NotionSegment[] = [];
  const initial: FormatState = {
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    code: false,
    href: null,
  };
  for (const child of Array.from(root.childNodes)) {
    domToSegmentsImpl(child, initial, out);
  }
  // 以 <br> 收尾时,最后那个是浏览器给"看得见的最后一行"放的占位,不算内容。
  const tail = out[out.length - 1];
  const leaf = root.lastChild ? lastLeaf(root) : null;
  if (tail && leaf instanceof HTMLBRElement && tail.text.endsWith("\n")) {
    tail.text = tail.text.slice(0, -1);
    if (tail.text === "") out.pop();
  }
  return out;
}

function wrapNodes(nodes: readonly Node[]): Node {
  const container = document.createElement("div");
  for (const node of nodes) container.append(node);
  return container;
}

export function fragmentToSegments(fragment: DocumentFragment): NotionSegment[] {
  return domToSegments(fragment);
}

// —— 光标工具 ——

function textNodesOf(element: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    out.push(current as Text);
    current = walker.nextNode();
  }
  return out;
}

/** 光标在元素纯文本中的偏移;没有选区或不在元素内时返回 null。 */
export function caretOffsetIn(element: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) return null;
  let offset = 0;
  for (const text of textNodesOf(element)) {
    if (text === range.startContainer) return offset + range.startOffset;
    offset += text.textContent?.length ?? 0;
  }
  return offset;
}

export function setCaretAtOffset(element: HTMLElement, offset: number): void {
  const selection = window.getSelection();
  if (!selection) return;
  const nodes = textNodesOf(element);
  if (nodes.length === 0) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  let remaining = offset;
  for (const text of nodes) {
    const length = text.textContent?.length ?? 0;
    if (remaining <= length) {
      const range = document.createRange();
      range.setStart(text, Math.max(0, remaining));
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= length;
  }
  const last = nodes[nodes.length - 1];
  if (!last) return;
  const range = document.createRange();
  range.setStart(last, last.textContent?.length ?? 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** 光标是否位于元素文本的最末尾。 */
export function caretAtEnd(element: HTMLElement): boolean {
  const offset = caretOffsetIn(element);
  if (offset === null) return false;
  return offset >= (element.textContent?.length ?? 0);
}

/** 从光标处到元素末尾的内容切出来(Enter 分块);原元素保留光标之前的部分。 */
export function extractTailFromCaret(element: HTMLElement): NotionSegment[] {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return [];
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) return [];
  const tail = document.createRange();
  tail.setStart(range.endContainer, range.endOffset);
  tail.setEnd(element, element.childNodes.length);
  const fragment = tail.extractContents();
  return fragmentToSegments(fragment);
}

/** 选区是否完整落在这个元素里且非空。 */
export function selectionInside(element: HTMLElement): Selection | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  return selection;
}


// —— 跨块光标移动(方向键走到块首/块尾时进入相邻块) ——

function caretRect(element: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) return null;
  const rects = range.getClientRects();
  const rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
  return rect && (rect.height > 0 || rect.width > 0) ? rect : null;
}

/** 光标是否在第一行(dir=-1)/最后一行(dir=1);空块或量不出来时按"在边缘"处理。 */
export function caretOnEdgeLine(element: HTMLElement, dir: -1 | 1): boolean {
  const rect = caretRect(element);
  if (!rect) return true;
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const line = Number.parseFloat(style.lineHeight) || rect.height || 16;
  if (dir < 0) return rect.top - (box.top + (Number.parseFloat(style.paddingTop) || 0)) < line * 0.8;
  return box.bottom - (Number.parseFloat(style.paddingBottom) || 0) - rect.bottom < line * 0.8;
}

/**
 * 把光标移到文档顺序里相邻的可编辑块;保持水平位置(x),没有相邻块返回 false。
 * x 为 null 时落在块首(向下/向右)或块尾(向上/向左)。
 */
export function moveCaretToNeighbor(
  element: HTMLElement,
  dir: -1 | 1,
  options: { keepX: boolean },
): boolean {
  const scope = element.closest(".knowledge-blocks");
  if (!scope) return false;
  const all = Array.from(scope.querySelectorAll<HTMLElement>("[contenteditable='true'], [contenteditable='']"));
  const next = all[all.indexOf(element) + dir];
  if (!next) return false;
  const x = options.keepX ? caretRect(element)?.left ?? null : null;
  next.focus();
  if (x !== null && typeof document.caretRangeFromPoint === "function") {
    const box = next.getBoundingClientRect();
    const y = dir < 0 ? box.bottom - 4 : box.top + 4;
    const range = document.caretRangeFromPoint(x, y);
    if (range && next.contains(range.startContainer)) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    }
  }
  setCaretAtOffset(next, dir < 0 ? (next.textContent?.length ?? 0) : 0);
  return true;
}
