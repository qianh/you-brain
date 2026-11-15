import { useEffect, useRef, useState } from "react";

import { useImeGuard } from "../lib/ime-guard.js";

/**
 * 提交一次改名：去首尾空白；为空或和原值一样就不调用 onSubmit。
 * onSubmit 抛错时不向外抛，而是把错误交回，由调用方恢复原值并显示。
 */
export async function submitRename(
  value: string,
  draft: string,
  onSubmit: (next: string) => Promise<void>,
): Promise<{ submitted: boolean; error: unknown }> {
  const next = draft.trim();
  if (next === "" || next === value.trim()) return { submitted: false, error: null };
  try {
    await onSubmit(next);
    return { submitted: true, error: null };
  } catch (error) {
    return { submitted: false, error };
  }
}

/**
 * 双击改名的标题：回车或失焦提交，Esc 取消。
 * onSubmit 失败时恢复原值，并把错误交给 onError（没有就吞掉，由调用方自己在 onSubmit 里提示也行）。
 */
export function InlineRename({ value, onSubmit, onError, label }: {
  value: string;
  onSubmit: (next: string) => Promise<void>;
  onError?: (error: unknown) => void;
  /** 输入框的无障碍名称。 */
  label?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 回车、Esc、失焦只处理第一次：回车提交后输入框卸载会再触发一次失焦。 */
  const finished = useRef(false);
  const ime = useImeGuard();

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const finish = (commit: boolean): void => {
    if (finished.current) return;
    finished.current = true;
    setEditing(false);
    if (!commit) return;
    void submitRename(value, draft, onSubmit).then((result) => {
      if (result.error !== null && result.error !== undefined) {
        setDraft(value);
        onError?.(result.error);
      }
    });
  };

  if (!editing) {
    return (
      <span
        className="inline-rename"
        onDoubleClick={(event) => {
          event.stopPropagation();
          finished.current = false;
          setDraft(value);
          setEditing(true);
        }}
      >
        {value}
      </span>
    );
  }
  return (
    <input
      ref={inputRef}
      className="inline-rename-input"
      value={draft}
      aria-label={label}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onCompositionStart={ime.onCompositionStart}
      onCompositionEnd={ime.onCompositionEnd}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          if (ime.isComposing(event)) return;
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}
