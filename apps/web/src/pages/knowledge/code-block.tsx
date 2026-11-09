import { useEffect, useRef, useState, type ReactNode } from "react";

import type { NotionBlockModel } from "@you-brain/core/http/types.js";

import type { MessageKey } from "../../i18n/messages.js";
import { highlightCode } from "../../lib/highlight.js";

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Notion 代码块的常用语言(取值与接口一致)。 */
export const CODE_LANGUAGES = [
  "plain text", "bash", "c", "c#", "c++", "css", "diff", "docker", "go", "graphql", "html", "java", "javascript", "json", "kotlin",
  "latex", "lua", "makefile", "markdown", "mermaid", "objective-c", "php", "powershell", "python", "r", "ruby", "rust", "scala",
  "shell", "sql", "swift", "toml", "typescript", "xml", "yaml",
];

/** 代码块行内编辑(Notion 同款):直接在块里改,语法高亮跟着变,停顿后自动保存。 */
export function CodeBlock({
  block,
  t,
  focusRequested,
  onFocusHandled,
  onSave,
  onEmptyBackspace,
  onEscape,
}: {
  block: Extract<NotionBlockModel, { kind: "code" }>;
  t: Translate;
  focusRequested: boolean;
  onFocusHandled: () => void;
  onSave: (text: string, language: string) => void;
  /** 空代码块里退格:变回普通段落。 */
  onEmptyBackspace: () => void;
  /** Esc:退出编辑并选中整块。 */
  onEscape: () => void;
}): ReactNode {
  const [text, setText] = useState(block.text);
  const [copied, setCopied] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);
  const latest = useRef({ onSave, language: block.language });
  latest.current = { onSave, language: block.language };

  // 别处改了(撤销、同步):不在编辑时跟着更新。
  useEffect(() => {
    if (document.activeElement !== area.current) setText(block.text);
  }, [block.text]);

  useEffect(() => {
    if (!focusRequested) return;
    const el = area.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    onFocusHandled();
  }, [focusRequested, onFocusHandled]);

  const flush = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current === null) return;
    const value = pending.current;
    pending.current = null;
    latest.current.onSave(value, latest.current.language);
  };
  useEffect(() => () => flush(), []);

  const change = (value: string): void => {
    setText(value);
    pending.current = value;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 700);
  };

  /** 方向键在首行/末行继续走到相邻块(和正文一样)。 */
  const leave = (dir: -1 | 1): boolean => {
    const el = area.current;
    if (!el) return false;
    const all = Array.from(document.querySelectorAll<HTMLElement>(".knowledge-blocks [contenteditable='true'], .knowledge-blocks textarea.nb-code-input"));
    const next = all[all.indexOf(el) + dir];
    if (!next) return false;
    flush();
    next.focus();
    if (next instanceof HTMLTextAreaElement) {
      const at = dir > 0 ? 0 : next.value.length;
      next.setSelectionRange(at, at);
    } else {
      const range = document.createRange();
      range.selectNodeContents(next);
      range.collapse(dir > 0);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    return true;
  };

  return (
    <figure className="nb-code nb-code-live">
      <div className="nb-code-bar">
        <select
          className="nb-code-language"
          value={CODE_LANGUAGES.includes(block.language) ? block.language : block.language || "plain text"}
          onChange={(event) => {
            const language = event.target.value;
            if (timer.current) clearTimeout(timer.current);
            pending.current = null;
            onSave(text, language);
          }}
        >
          {(CODE_LANGUAGES.includes(block.language) || block.language === "" ? CODE_LANGUAGES : [block.language, ...CODE_LANGUAGES]).map((language) => (
            <option key={language} value={language}>
              {language}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="nb-code-copy"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? t("knowledgeCodeCopied") : t("knowledgeCodeCopy")}
        </button>
      </div>
      <div className="nb-code-editor">
        <pre aria-hidden="true">
          <code dangerouslySetInnerHTML={{ __html: `${highlightCode(text, block.language)}\n` }} />
        </pre>
        <textarea
          ref={area}
          className="nb-code-input"
          value={text}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={t("knowledgeCodePlaceholder")}
          onChange={(event) => change(event.target.value)}
          onBlur={flush}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            const el = event.currentTarget;
            if (event.key === "Tab") {
              // Tab 缩进两个空格,Shift+Tab 去掉行首缩进。
              event.preventDefault();
              const { selectionStart: start, selectionEnd: end, value } = el;
              if (event.shiftKey) {
                const lineStart = value.lastIndexOf("\n", start - 1) + 1;
                const strip = value.slice(lineStart, lineStart + 2).match(/^ {1,2}/u)?.[0].length ?? 0;
                if (strip === 0) return;
                const next = value.slice(0, lineStart) + value.slice(lineStart + strip);
                change(next);
                requestAnimationFrame(() => el.setSelectionRange(Math.max(lineStart, start - strip), Math.max(lineStart, end - strip)));
              } else {
                const next = `${value.slice(0, start)}  ${value.slice(end)}`;
                change(next);
                requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
              }
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              flush();
              el.blur();
              onEscape();
              return;
            }
            if (event.key === "Backspace" && el.value === "") {
              event.preventDefault();
              if (timer.current) clearTimeout(timer.current);
              pending.current = null;
              onEmptyBackspace();
              return;
            }
            if (event.key === "ArrowUp" && !event.shiftKey && el.selectionStart === el.selectionEnd && !el.value.slice(0, el.selectionStart).includes("\n")) {
              if (leave(-1)) event.preventDefault();
              return;
            }
            if (event.key === "ArrowDown" && !event.shiftKey && el.selectionStart === el.selectionEnd && !el.value.slice(el.selectionEnd).includes("\n")) {
              if (leave(1)) event.preventDefault();
            }
          }}
        />
      </div>
    </figure>
  );
}
