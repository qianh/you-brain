import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { NotionBlockModel, NotionSegment } from "@you-brain/core/http/types.js";

import { useImeGuard } from "../../lib/ime-guard.js";
import type { BlockEditorCallbacks } from "./block-editor.js";
import type { Translate } from "./blocks-view.js";
import { caretOffsetIn, caretOnEdgeLine, domToSegments, segmentsToHtml, setCaretAtOffset } from "./dom-text.js";
import { deleteTableColumn, insertTableColumn, isEmptyRow, tableWidthOf } from "./logic.js";

type TableBlock = Extract<NotionBlockModel, { kind: "table" }>;

interface CellFocus {
  row: number;
  col: number;
  at: "start" | "end";
}

/**
 * 可编辑表格(Notion 同款):单元格直接输入,停顿后整行保存;
 * 回车在下方新增一行,Shift+回车格内换行;Tab/Shift+Tab 前后移格(末格 Tab 新增一行);
 * 方向键跨格、跨出表格;整行为空时行首退格删行;工具栏切换表头、增删行列。
 */
export function TableEditor({
  block,
  editor,
  t,
}: {
  block: TableBlock;
  editor: BlockEditorCallbacks;
  t: Translate;
}): ReactNode {
  const tableRef = useRef<HTMLTableElement>(null);
  const ime = useImeGuard();
  const width = tableWidthOf(block);
  const [active, setActive] = useState<{ row: number; col: number } | null>(null);
  const pendingFocus = useRef<CellFocus | null>(null);
  /** 改过还没存的行:输入当时就把整行内容取下来(卸载时 DOM 可能已经不在了)。 */
  const dirtyRows = useRef(new Map<number, NotionSegment[][]>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ block, editor });
  latest.current = { block, editor };

  const cellElement = useCallback((row: number, col: number): HTMLElement | null => {
    return tableRef.current?.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`) ?? null;
  }, []);

  /** 把没存的行写出去(整行一起存,Notion 的行是一个块)。结构操作前必须先调,行号才对得上。 */
  const flush = useCallback((): void => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const { block: current, editor: callbacks } = latest.current;
    const rows = [...dirtyRows.current.entries()].sort(([a], [b]) => a - b);
    dirtyRows.current.clear();
    for (const [row, cells] of rows) callbacks.tableEdit(current, { op: "update-row", rowIndex: row, cells });
  }, []);

  const scheduleSave = useCallback(
    (row: number): void => {
      const current = latest.current.block;
      dirtyRows.current.set(
        row,
        Array.from({ length: tableWidthOf(current) }, (_, col) => {
          const el = cellElement(row, col);
          return el ? domToSegments(el) : (current.rows[row]?.[col] ?? []);
        }),
      );
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const tick = (): void => {
        if (ime.isComposingNow()) saveTimer.current = setTimeout(tick, 400);
        else flush();
      };
      saveTimer.current = setTimeout(tick, 700);
    },
    [cellElement, flush, ime],
  );

  // 卸载(切页)时没存的行补存一次。
  useEffect(() => () => flush(), [flush]);

  // 结构变化后(新增/删除行列)把光标放到请求的格子里。
  useLayoutEffect(() => {
    const request = pendingFocus.current;
    if (!request) return;
    const el = cellElement(request.row, request.col);
    if (!el) return;
    pendingFocus.current = null;
    el.focus();
    setCaretAtOffset(el, request.at === "start" ? 0 : (el.textContent?.length ?? 0));
  });

  const focusCell = (row: number, col: number, at: "start" | "end"): boolean => {
    const el = cellElement(row, col);
    if (!el) return false;
    el.focus();
    setCaretAtOffset(el, at === "start" ? 0 : (el.textContent?.length ?? 0));
    return true;
  };

  /** 跳出表格:上方/下方相邻的可编辑区(没有就不动)。 */
  const leaveTable = (dir: -1 | 1): boolean => {
    const table = tableRef.current;
    const scope = table?.closest(".knowledge-blocks");
    if (!table || !scope) return false;
    const all = Array.from(scope.querySelectorAll<HTMLElement>("[contenteditable='true']"));
    const inside = all.filter((el) => table.contains(el));
    const edge = dir < 0 ? inside[0] : inside[inside.length - 1];
    const next = edge ? all[all.indexOf(edge) + dir] : undefined;
    if (!next) {
      if (dir < 0) {
        editor.focusTitle();
        return true;
      }
      return false;
    }
    next.focus();
    setCaretAtOffset(next, dir < 0 ? (next.textContent?.length ?? 0) : 0);
    return true;
  };

  const emptyRow = (): NotionSegment[][] => Array.from({ length: width }, () => []);

  const insertRowAfter = (row: number, col: number): void => {
    flush();
    pendingFocus.current = { row: row + 1, col, at: "start" };
    editor.tableEdit(block, { op: "insert-row", afterIndex: row, cells: emptyRow() });
  };

  /** 删行/重建会让行号错位:先让焦点离开(焦点所在格不会被刷新),操作后再按请求聚焦。 */
  const releaseFocus = (): void => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && tableRef.current?.contains(focused)) focused.blur();
  };

  const deleteRow = (row: number, col: number): void => {
    if (block.rows.length <= 1) return;
    flush();
    releaseFocus();
    pendingFocus.current = row > 0 ? { row: row - 1, col, at: "end" } : { row: 0, col, at: "start" };
    editor.tableEdit(block, { op: "delete-row", rowIndex: row });
  };

  /** 增删列:Notion 建表后不能改列数,整表重建(表格块会换 id,行内容不变)。 */
  const rebuildColumns = (rows: NotionSegment[][][], focus: CellFocus | null): void => {
    flush();
    releaseFocus();
    pendingFocus.current = focus;
    editor.tableEdit(block, {
      op: "rebuild",
      hasHeader: block.hasHeader,
      hasRowHeader: block.hasRowHeader ?? false,
      rows,
    });
  };

  /** 结构操作要用 DOM 里的最新文字(可能还没存)。 */
  const liveRows = (): NotionSegment[][][] =>
    block.rows.map((row, r) =>
      Array.from({ length: width }, (_, c) => {
        const el = cellElement(r, c);
        return el ? domToSegments(el) : (row[c] ?? []);
      }),
    );

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, row: number, col: number): void => {
    if (ime.isComposing(event)) return;
    const el = event.currentTarget;
    const mod = event.metaKey || event.ctrlKey;
    const lastRow = block.rows.length - 1;
    if (mod && (event.key === "b" || event.key === "i" || event.key === "u")) {
      event.preventDefault();
      document.execCommand(event.key === "b" ? "bold" : event.key === "i" ? "italic" : "underline");
      scheduleSave(row);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        document.execCommand("insertLineBreak");
        scheduleSave(row);
        return;
      }
      if (mod || event.altKey) return;
      insertRowAfter(row, col);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      if (event.shiftKey) {
        if (col > 0) focusCell(row, col - 1, "end");
        else if (row > 0) focusCell(row - 1, width - 1, "end");
        return;
      }
      if (col < width - 1) focusCell(row, col + 1, "start");
      else if (row < lastRow) focusCell(row + 1, 0, "start");
      else insertRowAfter(row, 0);
      return;
    }
    if (event.shiftKey || mod || event.altKey) return;
    if (event.key === "ArrowUp" && caretOnEdgeLine(el, -1)) {
      event.preventDefault();
      if (row > 0) focusCell(row - 1, col, "end");
      else leaveTable(-1);
      return;
    }
    if (event.key === "ArrowDown" && caretOnEdgeLine(el, 1)) {
      event.preventDefault();
      if (row < lastRow) focusCell(row + 1, col, "start");
      else leaveTable(1);
      return;
    }
    if (event.key === "ArrowLeft" && caretOffsetIn(el) === 0) {
      if (col > 0) {
        event.preventDefault();
        focusCell(row, col - 1, "end");
      } else if (row > 0) {
        event.preventDefault();
        focusCell(row - 1, width - 1, "end");
      }
      return;
    }
    if (event.key === "ArrowRight" && caretOffsetIn(el) === (el.textContent?.length ?? 0)) {
      if (col < width - 1) {
        event.preventDefault();
        focusCell(row, col + 1, "start");
      } else if (row < lastRow) {
        event.preventDefault();
        focusCell(row + 1, 0, "start");
      }
      return;
    }
    if (event.key === "Backspace" && caretOffsetIn(el) === 0 && col === 0) {
      const live = liveRows()[row] ?? [];
      if (isEmptyRow(live) && block.rows.length > 1) {
        event.preventDefault();
        deleteRow(row, col);
      }
    }
  };

  const current = active ?? { row: 0, col: 0 };
  return (
    <div className="nb-table-wrap" data-table-editing={active ? "true" : undefined}>
      <div className="nb-table-tools" role="toolbar" aria-label={t("knowledgeTableTools")}>
        <button
          type="button"
          className={block.hasHeader ? "is-on" : ""}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            flush();
            editor.tableEdit(block, { op: "set-header", hasHeader: !block.hasHeader });
          }}
        >
          {t("knowledgeTableHeaderRow")}
        </button>
        <button
          type="button"
          className={block.hasRowHeader ? "is-on" : ""}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            flush();
            editor.tableEdit(block, { op: "set-header", hasRowHeader: !(block.hasRowHeader ?? false) });
          }}
        >
          {t("knowledgeTableHeaderColumn")}
        </button>
        <span className="nb-table-tools-sep" />
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertRowAfter(current.row, current.col)}>
          {t("knowledgeTableAddRow")}
        </button>
        <button
          type="button"
          disabled={block.rows.length <= 1}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => deleteRow(current.row, current.col)}
        >
          {t("knowledgeTableDeleteRow")}
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() =>
            rebuildColumns(insertTableColumn(liveRows(), current.col), { row: current.row, col: current.col + 1, at: "start" })
          }
        >
          {t("knowledgeTableAddColumn")}
        </button>
        <button
          type="button"
          disabled={width <= 1}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() =>
            rebuildColumns(deleteTableColumn(liveRows(), current.col), {
              row: current.row,
              col: Math.max(0, current.col - 1),
              at: "end",
            })
          }
        >
          {t("knowledgeTableDeleteColumn")}
        </button>
      </div>
      <table className="nb-table nb-table-edit" ref={tableRef}>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {Array.from({ length: width }, (_, colIndex) => {
                const header = (rowIndex === 0 && block.hasHeader) || (colIndex === 0 && (block.hasRowHeader ?? false));
                const CellTag = header ? "th" : "td";
                return (
                  <CellTag key={colIndex}>
                    <EditableCell
                      row={rowIndex}
                      col={colIndex}
                      segments={row[colIndex] ?? []}
                      onFocus={() => setActive({ row: rowIndex, col: colIndex })}
                      onBlur={() => {
                        setActive(null);
                        flush();
                      }}
                      onInput={() => scheduleSave(rowIndex)}
                      onKeyDown={(event) => onKeyDown(event, rowIndex, colIndex)}
                      onCompositionStart={ime.onCompositionStart}
                      onCompositionEnd={ime.onCompositionEnd}
                    />
                  </CellTag>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 一个单元格的编辑区:没聚焦时跟随模型刷新内容,聚焦时不打断输入。 */
function EditableCell({
  row,
  col,
  segments,
  onFocus,
  onBlur,
  onInput,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
}: {
  row: number;
  col: number;
  segments: readonly NotionSegment[];
  onFocus: () => void;
  onBlur: () => void;
  onInput: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (event: { timeStamp: number }) => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement === el) return;
    const html = segmentsToHtml(segments);
    if (el.innerHTML !== html) el.innerHTML = html;
  }, [segments]);
  return (
    <div
      ref={ref}
      className="nb-cell-edit"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-cell={`${row}:${col}`}
      onFocus={onFocus}
      onBlur={onBlur}
      onInput={onInput}
      onKeyDown={onKeyDown}
      onCompositionStart={onCompositionStart}
      onCompositionEnd={onCompositionEnd}
      onPaste={(event) => {
        // 单元格里只粘纯文本(多行保留换行),不拆块。
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");
        document.execCommand("insertText", false, text);
      }}
    />
  );
}
