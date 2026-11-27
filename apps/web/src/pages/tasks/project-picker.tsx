import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { TASK_PROJECT_MAX_COUNT, taskProjectIds, type TaskNewProject, type TaskProject } from "@you-brain/core/tasks/types.js";

import { Icon } from "../../components/icons.js";
import { Popover } from "../../components/popover.js";
import { Select } from "../../components/select.js";
import { useDaemon } from "../../daemon-context.js";
import { folderName, projectPickerRows, type ProjectPickerRow } from "./logic.js";

/** 选中的项目：已有 T3 项目用 id，新项目在保存 TODO 时才登记到 T3。 */
export type ProjectChoice = { projectId: string; relatedProjectIds?: string[] | undefined } | { newProject: TaskNewProject };

const sameFolder = (a: string, b: string): boolean => a.replace(/\/+$/u, "") === b.replace(/\/+$/u, "");

export function ProjectPicker({ projects, value, onChange, disabled = false, allowPickFolder = true, allowNew = true, maxProjects = TASK_PROJECT_MAX_COUNT }: {
  projects: readonly TaskProject[];
  value: ProjectChoice;
  onChange: (value: ProjectChoice) => void;
  disabled?: boolean;
  allowPickFolder?: boolean;
  allowNew?: boolean;
  maxProjects?: number;
}) {
  const { t } = useDaemon();
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const pickFolder = allowNew && allowPickFolder && typeof window !== "undefined" ? window.__TAURI__?.dialog?.open : undefined;
  const selectedIds = useMemo(() => "projectId" in value ? taskProjectIds(value) : [], [value]);
  const candidates = useMemo(() => [...projects, ...selectedIds.filter((id) => !projects.some((item) => item.id === id))
    .map((id) => ({ id, name: t("tasksUnknownProject"), cwd: "", enabled: false }))], [projects, selectedIds, t]);
  const rows = useMemo(() => projectPickerRows(candidates, query, pickFolder !== undefined, allowNew), [candidates, query, pickFolder, allowNew]);

  const selectedId = "projectId" in value ? value.projectId : null;
  const selected = selectedId ? projects.find((project) => project.id === selectedId) : undefined;
  const pending = "newProject" in value ? value.newProject : null;

  // 打开时定位到当前选中项；输入时定位到第一项（没有匹配时就是「新建项目」）。
  useEffect(() => {
    if (!open) return;
    const index = query.trim() === "" ? rows.findIndex((row) => isChosen(row)) : 0;
    setActive(Math.max(0, index));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);
  useEffect(() => { if (open) searchRef.current?.focus(); }, [open]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const close = (): void => { setOpen(false); setQuery(""); };
  function isChosen(row: ProjectPickerRow): boolean {
    if (row.kind === "none") return selectedId === "";
    if (row.kind === "project") return selectedIds.includes(row.project.id);
    return false;
  }

  const chooseExisting = (ids: string[]): void => {
    onChange({ projectId: ids[0] ?? "", relatedProjectIds: ids.slice(1) });
  };

  const chooseFolder = async (): Promise<void> => {
    if (!pickFolder) return;
    close();
    try {
      const picked = await pickFolder({ directory: true, multiple: false, title: t("tasksProjectAddFolder") });
      const cwd = typeof picked === "string" ? picked : Array.isArray(picked) ? picked[0] : null;
      if (!cwd) return;
      // 已在 T3 中的文件夹直接选中，不重复登记。
      const known = projects.find((project) => sameFolder(project.cwd, cwd));
      if (!known) onChange({ newProject: { name: folderName(cwd), cwd } });
      else if (!selectedIds.includes(known.id) && selectedIds.length < maxProjects) chooseExisting([...selectedIds, known.id]);
    } catch {
      // 用户取消或对话框打不开：保持原选择。
    }
  };

  const commit = (row: ProjectPickerRow): void => {
    if (disabled) return;
    if (row.kind === "folder") { void chooseFolder(); return; }
    if (row.kind === "none") onChange({ projectId: "" });
    else if (row.kind === "project") {
      if (maxProjects === 1) chooseExisting([row.project.id]);
      else {
        if (selectedIds.includes(row.project.id)) chooseExisting(selectedIds.filter((id) => id !== row.project.id));
        else if (selectedIds.length < maxProjects) chooseExisting([...selectedIds, row.project.id]);
        return;
      }
    } else onChange({ newProject: { name: row.name } });
    close();
  };

  const onKey = (event: ReactKeyboardEvent): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!rows.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + rows.length) % rows.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[active];
      if (row) commit(row);
    }
  };

  const triggerLabel = pending
    ? <><Icon name={pending.cwd ? "folder" : "plus"} size={14} /><span className="tasks-picker-name">{pending.name}</span><span className="tasks-picker-badge">{t("tasksProjectNewBadge")}</span></>
    : selected
      ? <><Icon name="folder" size={14} /><span className="tasks-picker-name">{selected.name}</span>{selectedIds.length > 1 && <span className="tasks-picker-badge">+{selectedIds.length - 1}</span>}</>
      : selectedId
        ? <span className="tasks-picker-muted">{t("tasksUnknownProject")}</span>
        : <span className="tasks-picker-muted">{t("tasksUnassigned")}</span>;

  return <div className="tasks-linked-picker"><Popover open={open} onClose={close} label={t("tasksProject")} matchWidth className="tasks-picker-pop" trigger={
    <button type="button" className="select-trigger tasks-picker-trigger" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
      aria-label={t("tasksProject")} disabled={disabled} title={selected?.cwd ?? pending?.cwd} onClick={() => (open ? close() : setOpen(true))}>
      <span className="select-value">{triggerLabel}</span>
      <Icon name="chevron-down" />
    </button>
  }>
    <div className="select-pop">
      <label className="picker-search tasks-picker-search">
        <Icon name="search" size={15} />
        <input ref={searchRef} value={query} placeholder={t("tasksProjectSearch")} aria-label={t("tasksProjectSearch")} disabled={disabled}
          aria-controls={listId} aria-activedescendant={`${listId}-${active}`} maxLength={100}
          onChange={(event) => setQuery(event.target.value)} onKeyDown={onKey} />
      </label>
      <div id={listId} ref={listRef} role="listbox" aria-multiselectable={maxProjects > 1} aria-label={t("tasksProject")} className="select-list tasks-picker-list">
        {rows.map((row, index) => {
          const chosen = isChosen(row);
          const action = row.kind === "create" || row.kind === "folder";
          const divider = action && index > 0 && rows[index - 1]!.kind !== "create" && rows[index - 1]!.kind !== "folder";
          return <div key={row.kind === "project" ? row.project.id : row.kind}>
            {divider && <div className="tasks-picker-divider" role="separator" />}
            <button type="button" role="option" id={`${listId}-${index}`} data-index={index} aria-selected={chosen} tabIndex={-1}
              disabled={disabled || (maxProjects > 1 && row.kind === "project" && !chosen && selectedIds.length >= maxProjects)}
              className={["select-option", "tasks-picker-option", action ? "is-action" : "", index === active ? "is-active" : ""].filter(Boolean).join(" ")}
              title={row.kind === "project" ? row.project.cwd : undefined}
              onMouseEnter={() => setActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => commit(row)}>
              <span className={`check-slot${row.kind === "project" ? " tasks-picker-checkbox" : ""}`} aria-hidden="true">{chosen ? <Icon name="check" /> : null}</span>
              {row.kind === "none" && <span className="tasks-picker-muted">{t("tasksUnassigned")}</span>}
              {row.kind === "project" && <span className="tasks-picker-label"><Icon name="folder" size={14} /><span className="tasks-picker-name">{row.project.name}</span>{row.hint && <small>{row.hint}</small>}</span>}
              {row.kind === "create" && <span className="tasks-picker-label"><Icon name="plus" size={14} /><span className="tasks-picker-name">{t("tasksProjectCreate", { name: row.name })}</span></span>}
              {row.kind === "folder" && <span className="tasks-picker-label"><Icon name="folder" size={14} /><span className="tasks-picker-name">{t("tasksProjectAddFolder")}</span><small>{t("tasksProjectAddFolderHint")}</small></span>}
            </button>
          </div>;
        })}
        {rows.length === 0 && <div className="select-empty">{t("tasksProjectNoMatch")}</div>}
      </div>
    </div>
  </Popover>{selectedIds.length > 1 && <div className="tasks-primary-picker">
    <span>{t("tasksPrimaryProject")}</span>
    <Select label={t("tasksPrimaryProject")} value={selectedIds[0]!} disabled={disabled}
      options={selectedIds.map((id) => ({ value: id, label: candidates.find((item) => item.id === id)!.name }))}
      onChange={(id) => chooseExisting([id, ...selectedIds.filter((item) => item !== id)])} />
  </div>}</div>;
}
