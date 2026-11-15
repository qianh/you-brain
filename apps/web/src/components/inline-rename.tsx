import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";

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

/** 一次编辑的状态。「已结束」防止回车提交后输入框卸载又触发失焦、卸载时重复提交。 */
export interface EditState {
  editing: boolean;
  draft: string;
  finished: boolean;
}

/** 开始编辑：双击和外部的「编辑」按钮都走这里，草稿和「已结束」标记总是同样重置。 */
export function beginEdit(value: string): EditState {
  return { editing: true, draft: value, finished: false };
}

/** 结束编辑：只在编辑进行中返回 commit: true，一次编辑最多提交一次。 */
export function endEdit(state: EditState): { state: EditState; commit: boolean } {
  if (!state.editing || state.finished) return { state, commit: false };
  return { state: { ...state, editing: false, finished: true }, commit: true };
}

/** 外部（如列表行上的铅笔按钮）开始编辑用的句柄。 */
export interface InlineRenameHandle {
  startEditing: () => void;
}

/**
 * 双击改名的标题：回车或失焦提交，Esc 取消；组件卸载时若还在编辑，同样按提交处理。
 * onSubmit 失败时恢复原值，并把错误交给 onError。
 */
export function InlineRename({ value, onSubmit, onError, label, controlRef }: {
  value: string;
  onSubmit: (next: string) => Promise<void>;
  onError?: (error: unknown) => void;
  /** 输入框的无障碍名称。 */
  label?: string;
  /** 取得 startEditing，供外部按钮触发编辑。 */
  controlRef?: Ref<InlineRenameHandle>;
}) {
  const [edit, setEdit] = useState<EditState>({ editing: false, draft: value, finished: false });
  // 事件处理和卸载清理读 ref，拿到的总是最新状态。
  const editRef = useRef(edit);
  const latest = useRef({ value, onSubmit, onError });
  latest.current = { value, onSubmit, onError };
  const inputRef = useRef<HTMLInputElement>(null);
  const ime = useImeGuard();

  const update = (next: EditState): void => {
    editRef.current = next;
    setEdit(next);
  };
  const start = (): void => update(beginEdit(latest.current.value));
  useImperativeHandle(controlRef, () => ({ startEditing: start }));

  const commit = (draft: string): void => {
    const { value: original, onSubmit: submit, onError: report } = latest.current;
    void submitRename(original, draft, submit).then((result) => {
      if (result.error !== null && result.error !== undefined) report?.(result.error);
    });
  };
  const finish = (shouldCommit: boolean): void => {
    const ended = endEdit(editRef.current);
    update(ended.state);
    if (ended.commit && shouldCommit) commit(editRef.current.draft);
  };

  // 编辑中被卸载（关标签、返回）时失焦事件不一定触发，这里按提交处理，结果是确定的。
  useEffect(() => () => {
    const ended = endEdit(editRef.current);
    editRef.current = ended.state;
    if (ended.commit) commit(ended.state.draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!edit.editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [edit.editing]);

  if (!edit.editing) {
    return (
      <span
        className="inline-rename"
        onDoubleClick={(event) => {
          event.stopPropagation();
          start();
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
      value={edit.draft}
      aria-label={label}
      spellCheck={false}
      onChange={(event) => update({ ...editRef.current, draft: event.target.value })}
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
