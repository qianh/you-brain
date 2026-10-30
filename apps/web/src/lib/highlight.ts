import Prism from "prismjs";
// Notion 同款分词器:核心自带 markup/css/clike/javascript,这里补齐语言选择器里列的其余语言。
import "prismjs/components/prism-bash";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-python";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-java";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-powershell";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-diff";

/** Notion 语言名 → Prism 语言 key(小写已归一)。 */
const LANGUAGE_ALIASES: Record<string, string> = {
  "plain text": "",
  bash: "bash",
  shell: "bash",
  sh: "bash",
  zsh: "bash",
  console: "bash",
  python: "python",
  py: "python",
  json: "json",
  javascript: "javascript",
  js: "javascript",
  typescript: "typescript",
  ts: "typescript",
  markdown: "markdown",
  md: "markdown",
  html: "markup",
  xml: "markup",
  markup: "markup",
  css: "css",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  java: "java",
  go: "go",
  golang: "go",
  rust: "rust",
  c: "c",
  "c++": "cpp",
  cpp: "cpp",
  docker: "docker",
  dockerfile: "docker",
  diff: "diff",
  powershell: "powershell",
  pwsh: "powershell",
  ps1: "powershell",
};

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 用 Prism(与 Notion 同一 grammar)高亮;未知语言原样转义。 */
export function highlightCode(text: string, language: string | undefined): string {
  const key = LANGUAGE_ALIASES[(language ?? "").trim().toLowerCase()] ?? "";
  if (key === "" || !Prism.languages[key]) return escapeHtml(text);
  try {
    return Prism.highlight(text, Prism.languages[key], key);
  } catch {
    return escapeHtml(text);
  }
}
