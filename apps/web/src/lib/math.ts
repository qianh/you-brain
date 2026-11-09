import katex from "katex";
import "katex/dist/katex.min.css";

/**
 * LaTeX → HTML(KaTeX)。语法错误不抛,显示成红色原文,和 Notion 一样能看出哪里写错了。
 * 同一个式子反复渲染(编辑时每次重画)走缓存。
 */
const cache = new Map<string, string>();

export function renderMath(expression: string, display = false): string {
  const key = `${display ? "D" : "I"}${expression}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    html = katex.renderToString(expression, {
      displayMode: display,
      throwOnError: false,
      // 只输出 HTML:MathML 里的注释文本会被 contentEditable 当成正文,干扰光标位置。
      output: "html",
      strict: "ignore",
      trust: false,
    });
  } catch {
    html = expression.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, html);
  return html;
}
