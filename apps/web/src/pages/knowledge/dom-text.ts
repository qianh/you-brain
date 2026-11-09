import type { NotionSegment } from "@you-brain/core/http/types.js";
import { renderMath } from "../../lib/math.js";

/**
 * 所见即所得编辑的 DOM 层:富文本段落 ↔ contentEditable 内容,
 * 以及光标在纯文本偏移上的定位工具。
 *
 * 支持的行内标签与 core 的 markdown-text 同一集合:
 * b/strong、i/em、u、s/strike/del、code、a[href];
 * 另有 span[data-color](文字/背景色)、span[data-mention](@ 提及,整体不可编辑)、
 * span[data-equation](行内公式,整体不可编辑),保证编辑后这些格式原样写回 Notion。
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

function escapeAttr(text: string): string {
  return escapeHtml(text).replaceAll('"', "&quot;");
}

function segmentsToHtmlRaw(segments: readonly NotionSegment[]): string {
  return segments
    .map((segment) => {
      let html = escapeHtml(segment.text).replaceAll("\n", "<br>");
      if (segment.equation !== undefined) {
        html = equationHtml(segment.equation);
      } else if (segment.mention) {
        html = `<span class="nb-mention" contenteditable="false" data-mention="${escapeAttr(JSON.stringify(segment.mention))}">${html}</span>`;
      }
      if (segment.code) html = `<code>${html}</code>`;
      if (segment.bold) html = `<b>${html}</b>`;
      if (segment.italic) html = `<i>${html}</i>`;
      if (segment.underline) html = `<u>${html}</u>`;
      if (segment.strikethrough) html = `<s>${html}</s>`;
      if (segment.href && !segment.mention) html = `<a href="${escapeHtml(segment.href)}">${html}</a>`;
      if (segment.color !== "default") html = `<span data-color="${escapeAttr(segment.color)}" class="${colorClass(segment.color)}">${html}</span>`;
      return html;
    })
    .join("");
}

/** 与渲染层(blocks-view 的 RichSegment)同一套颜色类名。 */
export function colorClass(color: string): string {
  if (color === "default") return "";
  if (color.endsWith("_background")) return `nb-bg nb-bg-${color.slice(0, -"_background".length)}`;
  return `nb-color-${color}`;
}

interface FormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  code: boolean;
  href: string | null;
  color: string;
}

function domToSegmentsImpl(
  node: Node,
  state: FormatState,
  out: NotionSegment[],
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    // 零宽空格只是行内格式化后让光标跳出格式用的,不是内容。
    const text = (node.textContent ?? "").replace(/\u200B/gu, "");
    if (text === "") return;
    const last = out[out.length - 1];
    if (
      last &&
      !last.mention &&
      last.equation === undefined &&
      last.bold === state.bold &&
      last.italic === state.italic &&
      last.underline === state.underline &&
      last.strikethrough === state.strikethrough &&
      last.code === state.code &&
      last.href === state.href &&
      last.color === state.color
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
      color: state.color,
    });
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  // 提及、公式是不可拆的整体:取出原对象,不再往里走。
  const equation = element.getAttribute("data-equation");
  if (equation !== null) {
    out.push({ ...segmentBase(state), text: equation, equation });
    return;
  }
  const mention = element.getAttribute("data-mention");
  if (mention !== null) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(mention) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    const text = element.textContent ?? "";
    out.push(parsed ? { ...segmentBase(state), text, mention: parsed } : { ...segmentBase(state), text });
    return;
  }
  if (tag === "br") {
    // Shift+Enter 的软换行;末尾那个占位 br 在 domToSegments 里统一扣掉。
    domToSegmentsImpl(document.createTextNode("\n"), state, out);
    return;
  }
  const next = applyTag(state, element);
  for (const child of Array.from(element.childNodes)) {
    domToSegmentsImpl(child, next, out);
  }
}

/** 一个元素给内部文字加上的格式。颜色只认 data-color(浏览器 foreColor 之类的标签不认)。 */
function applyTag(state: FormatState, element: Element): FormatState {
  const tag = element.tagName.toLowerCase();
  const next: FormatState = { ...state };
  if (tag === "b" || tag === "strong") next.bold = true;
  else if (tag === "i" || tag === "em") next.italic = true;
  else if (tag === "u") next.underline = true;
  else if (tag === "s" || tag === "strike" || tag === "del") next.strikethrough = true;
  else if (tag === "code") next.code = true;
  else if (tag === "a") next.href = element.getAttribute("href");
  const color = element.getAttribute("data-color");
  if (color) next.color = color;
  return next;
}

function initialState(): FormatState {
  return { bold: false, italic: false, underline: false, strikethrough: false, code: false, href: null, color: "default" };
}

/** 选区里的富文本(带上选区外层元素的格式,例如整段粗体里选中的几个字也算粗体)。 */
export function selectionSegments(element: HTMLElement): NotionSegment[] | null {
  const selection = selectionInside(element);
  if (!selection) return null;
  const range = selection.getRangeAt(0);
  const chain: Element[] = [];
  let current: Node | null = range.commonAncestorContainer;
  if (current && !(current instanceof Element)) current = current.parentNode;
  while (current instanceof Element && current !== element) {
    chain.unshift(current);
    current = current.parentNode;
  }
  let state = initialState();
  for (const ancestor of chain) state = applyTag(state, ancestor);
  const out: NotionSegment[] = [];
  for (const child of Array.from(range.cloneContents().childNodes)) domToSegmentsImpl(child, state, out);
  return out;
}

/** 用富文本替换当前选区;color 给定时整体包一层显式颜色(含 default,用来清掉外层颜色)。 */
export function replaceSelection(segments: readonly NotionSegment[], color?: string): void {
  let html = segmentsToHtmlRaw(segments.map((segment) => (color ? { ...segment, color: "default" } : segment)));
  if (color) html = `<span data-color="${escapeAttr(color)}" class="${colorClass(color)}">${html}</span>`;
  document.execCommand("insertHTML", false, html);
}

/** 选区在元素纯文本里的起止偏移(DOM 重画后也能按偏移还原)。 */
export function selectionOffsets(element: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  const probe = document.createRange();
  probe.selectNodeContents(element);
  probe.setEnd(range.startContainer, range.startOffset);
  const start = probe.toString().length;
  return { start, end: start + range.toString().length };
}

/** 按纯文本偏移选中一段。 */
export function selectOffsets(element: HTMLElement, start: number, end: number): void {
  const selection = window.getSelection();
  if (!selection) return;
  const locate = (offset: number): [Node, number] => {
    let remaining = offset;
    for (const node of textNodesOf(element)) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) return [node, remaining];
      remaining -= length;
    }
    return [element, element.childNodes.length];
  };
  const range = document.createRange();
  range.setStart(...locate(start));
  range.setEnd(...locate(end));
  selection.removeAllRanges();
  selection.addRange(range);
}

/** 光标前紧挨着的文字(不跨元素边界),给 @ 提及、/ 菜单判断触发用。 */
export function textBeforeCaret(element: HTMLElement): string {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return "";
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) return "";
  const probe = document.createRange();
  probe.selectNodeContents(element);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.toString();
}

export function mentionHtml(text: string, mention: Record<string, unknown>): string {
  return `<span class="nb-mention" contenteditable="false" data-mention="${escapeAttr(JSON.stringify(mention))}">${escapeHtml(text)}</span>`;
}

export function equationHtml(expression: string): string {
  return `<span class="nb-equation" contenteditable="false" data-equation="${escapeAttr(expression)}">${renderMath(expression)}</span>`;
}

function segmentBase(state: FormatState): NotionSegment {
  return {
    text: "",
    href: state.href,
    bold: state.bold,
    italic: state.italic,
    strikethrough: state.strikethrough,
    underline: state.underline,
    code: state.code,
    color: state.color,
  };
}

function lastLeaf(node: Node): Node {
  let current = node;
  while (current.lastChild) current = current.lastChild;
  return current;
}

export function domToSegments(element: readonly Node[] | Node): NotionSegment[] {
  const root = element instanceof Node ? element : wrapNodes(element);
  const out: NotionSegment[] = [];
  const initial = initialState();
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
  const all = Array.from(scope.querySelectorAll<HTMLElement>("[contenteditable='true'], [contenteditable=''], textarea.nb-code-input"));
  const next = all[all.indexOf(element) + dir];
  if (!next) return false;
  if (next instanceof HTMLTextAreaElement) {
    // 代码块:光标进到首行开头或末行结尾。
    next.focus();
    const at = dir < 0 ? next.value.length : 0;
    next.setSelectionRange(at, at);
    return true;
  }
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

/** Notion 的行内 Markdown:输入闭合符号的瞬间把 **粗体**、*斜体*、`代码`、~~删除线~~、$$公式$$ 转成格式。 */
const INLINE_RULES: ReadonlyArray<{ pattern: RegExp; open: number; tag: "b" | "i" | "s" | "code" | "equation" }> = [
  { pattern: /\$\$([^$\n]+?)\$\$$/u, open: 2, tag: "equation" },
  { pattern: /\*\*([^*\n]+?)\*\*$/u, open: 2, tag: "b" },
  { pattern: /~~([^~\n]+?)~~$/u, open: 2, tag: "s" },
  { pattern: /`([^`\n]+?)`$/u, open: 1, tag: "code" },
  { pattern: /(?:^|[^*\w])\*([^*\s](?:[^*\n]*[^*\s])?)\*$/u, open: 1, tag: "i" },
  { pattern: /(?:^|[^_\w])_([^_\s](?:[^_\n]*[^_\s])?)_$/u, open: 1, tag: "i" },
];

export function applyInlineMarkdown(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return false;
  const node = selection.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE || !element.contains(node)) return false;
  // 代码、公式、提及里面不转换。
  if (node.parentElement?.closest("code, .nb-equation, .nb-mention")) return false;
  const offset = selection.anchorOffset;
  const before = (node.textContent ?? "").slice(0, offset);
  for (const rule of INLINE_RULES) {
    const match = rule.pattern.exec(before);
    const inner = match?.[1];
    if (!match || !inner || inner.trim() === "") continue;
    const length = inner.length + rule.open * 2;
    const range = document.createRange();
    range.setStart(node, offset - length);
    range.setEnd(node, offset);
    selection.removeAllRanges();
    selection.addRange(range);
    const html = rule.tag === "equation" ? equationHtml(inner) : `<${rule.tag}>${escapeHtml(inner)}</${rule.tag}>`;
    // 末尾补一个零宽空格,接着打的字落在格式外面(Notion 同款)。
    document.execCommand("insertHTML", false, `${html}\u200B`);
    return true;
  }
  return false;
}
