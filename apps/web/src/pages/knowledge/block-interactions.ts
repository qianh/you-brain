import { useEffect, useRef, type RefObject } from "react";

import type { NotionBlockModel } from "@you-brain/core/http/types.js";

import type { BlockEditorCallbacks } from "./block-editor.js";
import { acceptsChildren, findBlockIn, isInside, placementOf, removeBlockIn, topmostSelected, type BlockPlacement } from "./logic.js";

/**
 * 页面级的块交互(Notion 同款):
 * - ⌘Z / ⌘⇧Z 撤销重做;
 * - Esc / 拖选 / Shift+点手柄 多选,选中后 ⌫ 删除、⌘C/⌘X 复制剪切、⌘D 复制一份、↑↓ 移动选区、⌘⇧↑↓ 移动块;
 * - 编辑中 ⌘D 复制当前块、⌘⇧↑↓ 上下移动、连按 ⌘A 选中全部块;
 * - 拖手柄排序(放在上方/下方/拖进去成为子块),把文件拖进来直接上传。
 */
export function useBlockInteractions(options: {
  container: RefObject<HTMLElement | null>;
  editor: BlockEditorCallbacks;
  selection: { current: Set<string> };
  setSelection: (ids: Iterable<string>) => void;
  blocks: () => NotionBlockModel[];
  undo: () => void;
  redo: () => void;
  enabled: boolean;
}): void {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (!options.enabled) return;
    const rowOf = (node: EventTarget | null): HTMLElement | null =>
      node instanceof Element ? node.closest<HTMLElement>(".knowledge-blocks [data-block-id]") : null;
    const allRows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".knowledge-blocks [data-block-id]"));
    const editingRow = (): HTMLElement | null => {
      const active = document.activeElement as HTMLElement | null;
      return active?.isContentEditable ? rowOf(active) : null;
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      const { editor, selection, setSelection, blocks, undo, redo } = latest.current;
      if (event.isComposing) return;
      const target = event.target as HTMLElement | null;
      // 编辑行里的 Esc 由行自己处理(退出编辑并选中这一块),这里不能再把选区清掉。
      if (event.key === "Escape" && target?.isContentEditable) return;
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      // 撤销/重做:输入框(标题、链接、说明)里交给浏览器自己的撤销。
      if (mod && !event.altKey && (key === "z" || key === "y") && !typing) {
        if (document.querySelector(".nb-scrim, [role='dialog']")) return;
        event.preventDefault();
        if (key === "y" || event.shiftKey) redo();
        else undo();
        return;
      }
      if (typing) return;
      const row = editingRow();
      if (row) {
        const id = row.dataset.blockId ?? "";
        if (mod && key === "d" && !event.shiftKey) {
          event.preventDefault();
          void editor.duplicate(id);
          return;
        }
        if (mod && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
          event.preventDefault();
          (document.activeElement as HTMLElement | null)?.blur();
          void editor.move(id, event.key === "ArrowUp" ? "up" : "down");
          return;
        }
        if (mod && key === "a" && !event.shiftKey) {
          // 第一次 ⌘A 选中这一块的文字;文字已全选(或块是空的)再按就选中全部块。
          const active = document.activeElement as HTMLElement;
          const text = active.textContent ?? "";
          const selected = window.getSelection()?.toString() ?? "";
          if (text === "" || selected.length >= text.length) {
            event.preventDefault();
            active.blur();
            window.getSelection()?.removeAllRanges();
            setSelection(blocks().map((block) => block.id));
          }
        }
        return;
      }
      if (selection.current.size === 0) return;
      const top = topmostSelected(blocks(), selection.current);
      if (top.length === 0) {
        setSelection([]);
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        editor.removeBlocks(top);
        return;
      }
      if (mod && (key === "c" || key === "x")) {
        event.preventDefault();
        editor.copyBlocks(top);
        if (key === "x") editor.removeBlocks(top);
        return;
      }
      if (mod && key === "d") {
        event.preventDefault();
        editor.duplicateBlocks(top);
        return;
      }
      if (event.key === "Escape") {
        setSelection([]);
        return;
      }
      if (mod && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && top.length === 1) {
        event.preventDefault();
        void editor.move(top[0]!, event.key === "ArrowUp" ? "up" : "down");
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        // 选区上下移动(Shift 扩展),按屏幕上的行顺序。
        event.preventDefault();
        const rows = allRows().map((element) => element.dataset.blockId ?? "");
        const positions = top.map((id) => rows.indexOf(id)).filter((index) => index >= 0);
        if (positions.length === 0) return;
        const edge = event.key === "ArrowUp" ? Math.min(...positions) - 1 : Math.max(...positions) + 1;
        const next = rows[Math.max(0, Math.min(rows.length - 1, edge))];
        if (!next) return;
        setSelection(event.shiftKey ? [...selection.current, next] : [next]);
        document.querySelector(`[data-block-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const first = top[0]!;
        setSelection([]);
        const editable = document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(first)}"] [contenteditable="true"]`);
        editable?.focus();
        return;
      }
      if (!mod && event.key.length === 1) setSelection([]);
    };

    // —— 拖选:按住鼠标从一块拖到另一块,切换成整块多选 ——
    let pressRow: HTMLElement | null = null;
    let blockMode = false;
    const onMouseDown = (event: MouseEvent): void => {
      const { selection, setSelection } = latest.current;
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (target.closest(".nb-handle, .nb-menu, .nb-scrim, .nb-floatbar, .nb-slash-menu, [role='dialog']")) return;
      pressRow = rowOf(target);
      blockMode = false;
      if (selection.current.size > 0 && !event.shiftKey) setSelection([]);
    };
    const onMouseMove = (event: MouseEvent): void => {
      if (!pressRow || (event.buttons & 1) === 0) return;
      const over = rowOf(document.elementFromPoint(event.clientX, event.clientY));
      if (!over || (over === pressRow && !blockMode)) return;
      const rows = allRows();
      const from = rows.indexOf(pressRow);
      const to = rows.indexOf(over);
      if (from < 0 || to < 0) return;
      if (!blockMode) {
        blockMode = true;
        (document.activeElement as HTMLElement | null)?.blur();
      }
      window.getSelection()?.removeAllRanges();
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      latest.current.setSelection(rows.slice(lo, hi + 1).map((row) => row.dataset.blockId ?? ""));
    };
    const onMouseUp = (): void => {
      pressRow = null;
      blockMode = false;
    };

    // —— 拖手柄排序(指针事件实现:桌面 App 的 WebView 里 HTML5 拖放不可靠,和侧栏拖页面一样);拖文件进来上传 ——
    let dragging: string[] | null = null;
    let marked: HTMLElement | null = null;
    const mark = (row: HTMLElement | null, zone: string | null): void => {
      if (marked && marked !== row) delete marked.dataset.drop;
      marked = row;
      if (row && zone) row.dataset.drop = zone;
      else if (row) delete row.dataset.drop;
    };
    const zoneOf = (row: HTMLElement, point: { clientX: number; clientY: number }): "before" | "after" | "inside" => {
      const line = (row.querySelector(":scope > .nb-row-main") ?? row).getBoundingClientRect();
      const head = Math.min(line.height, 40);
      const midline = line.top + head / 2;
      if (point.clientY < midline) return "before";
      const model = findBlockIn(latest.current.blocks(), row.dataset.blockId ?? "");
      return model && acceptsChildren(model) && point.clientX > line.left + 48 ? "inside" : "after";
    };
    /** 松手:按标记的位置移动被拖的块。 */
    const dropAt = (row: HTMLElement, zone: string, ids: string[]): void => {
      const { editor, blocks } = latest.current;
      const id = row.dataset.blockId ?? "";
      if (ids.length === 0 || ids.includes(id)) return;
      // 目标位置按「拖走之后」的树算,前一个兄弟可能正是被拖走的块。
      const rest = ids.reduce((acc, dragged) => removeBlockIn(acc, dragged), blocks());
      const here = placementOf(rest, id);
      if (!here) return;
      const target: BlockPlacement =
        zone === "before" ? here : zone === "inside" ? { parentId: id, afterId: null } : { parentId: here.parentId, afterId: id };
      if (zone === "inside" && !editor.isOpen(id)) editor.toggleOpen(id);
      editor.relocateBlocks(ids, target);
      // Notion:拖完后被移动的块保持选中,可以接着按键操作。
      (document.activeElement as HTMLElement | null)?.blur?.();
      latest.current.setSelection(ids);
    };
    let ghost: HTMLElement | null = null;
    let press: { x: number; y: number; id: string; handle: HTMLElement } | null = null;
    // 桌面 App 的 WebKit 有时只给 mouse 事件、不给 pointer 事件:两种都接,先到的生效。
    const onPointerMove = (event: MouseEvent): void => {
      if (!press) return;
      if (!dragging) {
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < 4) return;
        dragging = latest.current.editor.targetsFor(press.id);
        const source = press.handle.closest<HTMLElement>("[data-block-id]");
        ghost = document.createElement("div");
        ghost.className = "nb-drag-ghost";
        ghost.textContent = (source?.textContent ?? "").trim().slice(0, 60) || "…";
        document.body.appendChild(ghost);
        document.body.classList.add("nb-block-dragging");
        window.getSelection()?.removeAllRanges();
      }
      event.preventDefault();
      if (ghost) {
        ghost.style.left = `${event.clientX + 12}px`;
        ghost.style.top = `${event.clientY + 8}px`;
      }
      const row = rowOf(document.elementFromPoint(event.clientX, event.clientY));
      const blocks = latest.current.blocks();
      if (!row || dragging.some((dragged) => isInside(blocks, dragged, row.dataset.blockId ?? ""))) {
        mark(null, null);
        return;
      }
      mark(row, zoneOf(row, event));
    };
    const endPointerDrag = (): void => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mouseup", onPointerUp);
      window.removeEventListener("pointercancel", endPointerDrag);
      ghost?.remove();
      ghost = null;
      document.body.classList.remove("nb-block-dragging");
      press = null;
      dragging = null;
      mark(null, null);
    };
    const onPointerUp = (event: MouseEvent): void => {
      const current = press;
      let ids = dragging;
      // 移动事件可能很少(甚至没有):松手时按松手位置算,和侧栏拖页面一样。
      if (!ids && current && Math.hypot(event.clientX - current.x, event.clientY - current.y) >= 4) {
        ids = latest.current.editor.targetsFor(current.id);
      }
      endPointerDrag();
      if (!ids || !current) return;
      // 拖过就不算点击:别再弹出块菜单。
      current.handle.addEventListener("click", (click) => click.stopPropagation(), { capture: true, once: true });
      const row = rowOf(document.elementFromPoint(event.clientX, event.clientY));
      const blocks = latest.current.blocks();
      if (!row || ids.some((dragged) => isInside(blocks, dragged, row.dataset.blockId ?? ""))) return;
      dropAt(row, zoneOf(row, event), ids);
    };
    const onPointerDown = (event: MouseEvent): void => {
      if (event.button !== 0 || press) return;
      const handle = (event.target as Element | null)?.closest<HTMLElement>("[data-drag-handle]");
      if (!handle) return;
      press = { x: event.clientX, y: event.clientY, id: handle.dataset.dragHandle ?? "", handle };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("mousemove", onPointerMove);
      window.addEventListener("mouseup", onPointerUp);
      window.addEventListener("pointercancel", endPointerDrag);
    };
    // 从访达拖文件进来:放到目标块后面并上传。
    const onDragOver = (event: DragEvent): void => {
      if (!(event.dataTransfer?.types.includes("Files") ?? false)) return;
      const row = rowOf(event.target);
      mark(row, row ? "after" : null);
      if (!row) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent): void => {
      const row = marked;
      mark(null, null);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!row || files.length === 0) return;
      event.preventDefault();
      const model = findBlockIn(latest.current.blocks(), row.dataset.blockId ?? "");
      if (model) latest.current.editor.pasteFiles(model, files);
    };
    const onDragLeave = (event: DragEvent): void => {
      if (!options.container.current?.contains(event.relatedTarget as Node | null)) mark(null, null);
    };

    document.addEventListener("keydown", onKeyDown);
    const container = options.container.current;
    container?.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    container?.addEventListener("pointerdown", onPointerDown);
    container?.addEventListener("mousedown", onPointerDown);
    container?.addEventListener("dragover", onDragOver);
    container?.addEventListener("drop", onDrop);
    container?.addEventListener("dragleave", onDragLeave);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      container?.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      container?.removeEventListener("pointerdown", onPointerDown);
      container?.removeEventListener("mousedown", onPointerDown);
      container?.removeEventListener("dragover", onDragOver);
      container?.removeEventListener("drop", onDrop);
      container?.removeEventListener("dragleave", onDragLeave);
      endPointerDrag();
    };
    // 容器换了(切页)才重新挂;其余参数从 latest 读最新的。
  }, [options.container, options.enabled]);
}
