import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { NotionDatabaseView } from "@you-brain/core/http/types.js";

import type { MessageKey } from "../../i18n/messages.js";

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** 能直接改的列类型;公式、汇总、关联、人员、文件、创建时间等由 Notion 维护。 */
const EDITABLE = new Set(["title", "rich_text", "number", "url", "email", "phone_number", "checkbox", "select", "status", "multi_select", "date"]);
/** 新增列可选的类型(状态列 Notion 接口不能新建)。 */
const NEW_COLUMN_TYPES = ["rich_text", "number", "select", "multi_select", "date", "checkbox", "url", "email", "phone_number"] as const;

export type CellValue = string | boolean | string[] | null;
type Column = NotionDatabaseView["columns"][number];
type Row = NotionDatabaseView["rows"][number];
type ViewKind = "table" | "board" | "gallery" | "list" | "calendar";

interface ViewState {
  kind: ViewKind;
  sort: { column: string; dir: "asc" | "desc" } | null;
  groupBy: string | null;
  search: string;
}

function readView(databaseId: string): ViewState {
  try {
    const parsed = JSON.parse(localStorage.getItem(`you-brain:knowledge:db-view:${databaseId}`) ?? "null") as Partial<ViewState> | null;
    if (parsed) return { kind: parsed.kind ?? "table", sort: parsed.sort ?? null, groupBy: parsed.groupBy ?? null, search: "" };
  } catch {
    // 读不到就用默认视图。
  }
  return { kind: "table", sort: null, groupBy: null, search: "" };
}

function writeView(databaseId: string, view: ViewState): void {
  try {
    localStorage.setItem(`you-brain:knowledge:db-view:${databaseId}`, JSON.stringify({ ...view, search: "" }));
  } catch {
    // 只影响下次打开的默认视图。
  }
}

export function cellText(row: Row, column: Column): string {
  if (column.type === "title") return row.title;
  return row.cells.find((cell) => cell.name === column.name)?.text ?? "";
}

/** 单元格/属性的编辑器:点开就改,回车或失焦保存,Esc 放弃。表格视图和数据库行页面共用。 */
export function PropertyCell({
  column,
  text,
  t,
  placeholder,
  onChange,
}: {
  column: Column;
  text: string;
  t: Translate;
  placeholder?: string | undefined;
  onChange: (value: CellValue, display: string) => void;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const editable = EDITABLE.has(column.type);
  if (column.type === "checkbox") {
    const checked = text === "✓";
    return <input type="checkbox" className="nb-checkbox" checked={checked} onChange={() => onChange(!checked, checked ? "" : "✓")} />;
  }
  if (editing) {
    const listId = `db-options-${column.name}`;
    const commit = (): void => {
      setEditing(false);
      if (draft === text) return;
      const value: CellValue =
        column.type === "multi_select"
          ? draft
              .split(/[,,]/u)
              .map((part) => part.trim())
              .filter((part) => part !== "")
          : draft;
      onChange(value, draft);
    };
    return (
      <span className="knowledge-db-editing">
        <input
          autoFocus
          type={column.type === "date" ? "date" : column.type === "number" ? "number" : "text"}
          value={draft}
          list={column.options ? listId : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") setEditing(false);
          }}
        />
        {column.options ? (
          <datalist id={listId}>
            {column.options.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        ) : null}
      </span>
    );
  }
  const chips = column.type === "select" || column.type === "status" || column.type === "multi_select";
  return (
    <span
      className={editable ? "knowledge-db-cell" : "knowledge-db-cell is-readonly"}
      title={editable ? undefined : t("knowledgeDbReadOnlyColumn")}
      role={editable ? "button" : undefined}
      tabIndex={editable ? 0 : undefined}
      onClick={() => {
        if (!editable) return;
        setDraft(column.type === "date" ? (text.split(" → ")[0] ?? "") : text);
        setEditing(true);
      }}
    >
      {text === "" ? (
        <span className="knowledge-db-empty">{placeholder ?? ""}</span>
      ) : chips ? (
        text.split(/,\s*/u).map((part) => (
          <span key={part} className="knowledge-db-chip">
            {part}
          </span>
        ))
      ) : (
        text
      )}
    </span>
  );
}

/** 内嵌数据库:表格/看板/画廊/列表/日历视图,搜索、排序、分组,列的增删改,行的增删和单元格编辑。 */
export function DatabaseView({
  database: rawDatabase,
  t,
  untitled,
  onOpen,
  onCell,
  onAddRow,
  onDeleteRow,
  onSchema,
  inline,
}: {
  database: NotionDatabaseView;
  t: Translate;
  untitled: string;
  onOpen: (id: string) => void;
  onCell: (rowId: string, property: string, value: CellValue, display: string) => void;
  onAddRow: (preset?: { property: string; value: CellValue; display: string }) => void;
  onDeleteRow: (rowId: string) => void;
  onSchema: (change: { op: "add"; name: string; type: string } | { op: "rename"; name: string; newName: string } | { op: "delete"; name: string }) => void;
  /** 嵌在页面里显示(Notion 的内嵌数据库):标题小一号,点标题打开整页。 */
  inline?: boolean | undefined;
}): ReactNode {
  // Notion 界面里标题列总在最前面(接口返回的列顺序是乱的)。
  const database = useMemo(
    () => ({
      ...rawDatabase,
      columns: [...rawDatabase.columns.filter((column) => column.type === "title"), ...rawDatabase.columns.filter((column) => column.type !== "title")],
    }),
    [rawDatabase],
  );
  const [view, setViewState] = useState<ViewState>(() => readView(rawDatabase.databaseId));
  const setView = (patch: Partial<ViewState>): void => {
    setViewState((current) => {
      const next = { ...current, ...patch };
      writeView(database.databaseId, next);
      return next;
    });
  };
  const [columnMenu, setColumnMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ name: string; type: string } | null>(null);
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [dragRow, setDragRow] = useState<string | null>(null);

  const groupable = database.columns.filter((column) => column.type === "select" || column.type === "status");
  const dateColumn = database.columns.find((column) => column.type === "date");
  const groupBy = groupable.find((column) => column.name === view.groupBy) ?? groupable[0] ?? null;

  const rows = useMemo(() => {
    const needle = view.search.trim().toLowerCase();
    let list = database.rows.filter(
      (row) => needle === "" || row.title.toLowerCase().includes(needle) || row.cells.some((cell) => cell.text.toLowerCase().includes(needle)),
    );
    if (view.sort) {
      const column = database.columns.find((candidate) => candidate.name === view.sort?.column);
      if (column) {
        const dir = view.sort.dir === "asc" ? 1 : -1;
        list = [...list].sort((a, b) => {
          const left = cellText(a, column);
          const right = cellText(b, column);
          if (column.type === "number") return (Number(left || Number.NEGATIVE_INFINITY) - Number(right || Number.NEGATIVE_INFINITY)) * dir;
          return left.localeCompare(right, "zh") * dir;
        });
      }
    }
    return list;
  }, [database, view.search, view.sort]);

  const cardProps = database.columns.filter((column) => column.type !== "title").slice(0, 3);
  const card = (row: Row): ReactNode => (
    <div
      key={row.id}
      className={"knowledge-db-card" + (dragRow === row.id ? " is-dragging" : "")}
      draggable={view.kind === "board"}
      onDragStart={(event) => {
        setDragRow(row.id);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", row.id);
      }}
      onDragEnd={() => setDragRow(null)}
      onClick={() => onOpen(row.id)}
    >
      <div className="knowledge-db-card-title">
        {row.icon ?? "📄"} {row.title || untitled}
      </div>
      {cardProps.map((column) => {
        const text = cellText(row, column);
        return text ? (
          <div key={column.name} className="knowledge-db-card-prop">
            {text}
          </div>
        ) : null;
      })}
    </div>
  );

  const viewLabels: Record<ViewKind, MessageKey> = {
    table: "knowledgeDbViewTable",
    board: "knowledgeDbViewBoard",
    gallery: "knowledgeDbViewGallery",
    list: "knowledgeDbViewList",
    calendar: "knowledgeDbViewCalendar",
  };

  let body: ReactNode;
  if (view.kind === "board" && groupBy) {
    const groups = [...(groupBy.options ?? []), ""];
    body = (
      <div className="knowledge-db-board">
        {groups.map((group) => {
          const members = rows.filter((row) => cellText(row, groupBy) === group);
          return (
            <div
              key={group || "__none"}
              className="knowledge-db-lane"
              onDragOver={(event) => {
                if (dragRow) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const id = dragRow ?? event.dataTransfer.getData("text/plain");
                setDragRow(null);
                const row = database.rows.find((candidate) => candidate.id === id);
                if (row && cellText(row, groupBy) !== group) onCell(id, groupBy.name, group === "" ? null : group, group);
              }}
            >
              <div className="knowledge-db-lane-head">
                <span className="knowledge-db-chip">{group || t("knowledgeDbNoValue")}</span>
                <span className="knowledge-db-lane-count">{members.length}</span>
              </div>
              {members.map(card)}
              <button
                type="button"
                className="knowledge-db-add"
                onClick={() => onAddRow(group === "" ? undefined : { property: groupBy.name, value: group, display: group })}
              >
                ＋ {t("knowledgeDbAddRow")}
              </button>
            </div>
          );
        })}
      </div>
    );
  } else if (view.kind === "gallery") {
    body = <div className="knowledge-db-gallery">{rows.map(card)}</div>;
  } else if (view.kind === "list") {
    body = (
      <div className="knowledge-db-list">
        {rows.map((row) => (
          <button key={row.id} type="button" className="knowledge-db-list-row" onClick={() => onOpen(row.id)}>
            <span>
              {row.icon ?? "📄"} {row.title || untitled}
            </span>
            <span className="knowledge-db-list-props">
              {cardProps.map((column) => cellText(row, column)).filter(Boolean).join(" · ")}
            </span>
          </button>
        ))}
      </div>
    );
  } else if (view.kind === "calendar" && dateColumn) {
    const first = new Date(month.year, month.month, 1);
    const start = new Date(first);
    start.setDate(1 - ((first.getDay() + 6) % 7));
    const days = Array.from({ length: 42 }, (_, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      return day;
    });
    const key = (day: Date): string =>
      `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    body = (
      <div className="knowledge-db-calendar">
        <div className="knowledge-db-calendar-head">
          <button type="button" onClick={() => setMonth(({ year, month: m }) => (m === 0 ? { year: year - 1, month: 11 } : { year, month: m - 1 }))}>
            ‹
          </button>
          <span>
            {month.year} / {month.month + 1}
          </span>
          <button type="button" onClick={() => setMonth(({ year, month: m }) => (m === 11 ? { year: year + 1, month: 0 } : { year, month: m + 1 }))}>
            ›
          </button>
        </div>
        <div className="knowledge-db-calendar-grid">
          {days.map((day) => {
            const date = key(day);
            const members = rows.filter((row) => cellText(row, dateColumn).startsWith(date));
            return (
              <div
                key={date}
                className={"knowledge-db-day" + (day.getMonth() === month.month ? "" : " is-other")}
                onDragOver={(event) => {
                  if (dragRow) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragRow) onCell(dragRow, dateColumn.name, date, date);
                  setDragRow(null);
                }}
              >
                <span className="knowledge-db-day-num">{day.getDate()}</span>
                {members.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className="knowledge-db-event"
                    draggable
                    onDragStart={() => setDragRow(row.id)}
                    onClick={() => onOpen(row.id)}
                  >
                    {row.title || untitled}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    );
  } else {
    body = (
      <table className="nb-table knowledge-db-table">
        <thead>
          <tr>
            <th />
            {database.columns.map((column) => (
              <th key={column.name} className="knowledge-db-th">
                {renaming === column.name ? (
                  <input
                    autoFocus
                    defaultValue={column.name}
                    onBlur={(event) => {
                      setRenaming(null);
                      const next = event.target.value.trim();
                      if (next !== "" && next !== column.name) onSchema({ op: "rename", name: column.name, newName: next });
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <button type="button" className="knowledge-db-th-button" onClick={() => setColumnMenu(columnMenu === column.name ? null : column.name)}>
                    {column.name} <span className="knowledge-db-type">{column.type}</span>
                    {view.sort?.column === column.name ? (view.sort.dir === "asc" ? " ↑" : " ↓") : ""}
                  </button>
                )}
                {columnMenu === column.name ? (
                  <>
                    <div className="nb-scrim" onClick={() => setColumnMenu(null)} role="presentation" />
                    <div className="nb-menu knowledge-db-column-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => (setColumnMenu(null), setView({ sort: { column: column.name, dir: "asc" } }))}>
                        ↑ {t("knowledgeDbSortAsc")}
                      </button>
                      <button type="button" role="menuitem" onClick={() => (setColumnMenu(null), setView({ sort: { column: column.name, dir: "desc" } }))}>
                        ↓ {t("knowledgeDbSortDesc")}
                      </button>
                      {view.sort?.column === column.name ? (
                        <button type="button" role="menuitem" onClick={() => (setColumnMenu(null), setView({ sort: null }))}>
                          ✕ {t("knowledgeDbSortClear")}
                        </button>
                      ) : null}
                      <button type="button" role="menuitem" onClick={() => (setColumnMenu(null), setRenaming(column.name))}>
                        ✎ {t("knowledgeRename")}
                      </button>
                      {column.type !== "title" ? (
                        <button type="button" role="menuitem" className="is-danger" onClick={() => (setColumnMenu(null), onSchema({ op: "delete", name: column.name }))}>
                          🗑 {t("knowledgeDbDeleteColumn")}
                        </button>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </th>
            ))}
            <th className="knowledge-db-th-add">
              {adding ? (
                <span className="knowledge-db-new-column">
                  <input
                    autoFocus
                    value={adding.name}
                    placeholder={t("knowledgeDbColumnName")}
                    onChange={(event) => setAdding({ ...adding, name: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "Escape") setAdding(null);
                      if (event.key === "Enter" && adding.name.trim() !== "") {
                        onSchema({ op: "add", name: adding.name.trim(), type: adding.type });
                        setAdding(null);
                      }
                    }}
                  />
                  <select value={adding.type} onChange={(event) => setAdding({ ...adding, type: event.target.value })}>
                    {NEW_COLUMN_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={adding.name.trim() === ""}
                    onClick={() => {
                      onSchema({ op: "add", name: adding.name.trim(), type: adding.type });
                      setAdding(null);
                    }}
                  >
                    ✓
                  </button>
                </span>
              ) : (
                <button type="button" className="knowledge-db-add" aria-label={t("knowledgeDbAddColumn")} title={t("knowledgeDbAddColumn")} onClick={() => setAdding({ name: "", type: "rich_text" })}>
                  ＋
                </button>
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <button type="button" className="knowledge-db-title" title={t("knowledgeDbOpenRow")} onClick={() => onOpen(row.id)}>
                  {row.icon ?? "📄"}
                </button>
              </td>
              {database.columns.map((column) => (
                <td key={column.name}>
                  <PropertyCell
                    column={column}
                    text={cellText(row, column)}
                    t={t}
                    placeholder={column.type === "title" ? untitled : undefined}
                    onChange={(value, display) => onCell(row.id, column.name, value, display)}
                  />
                </td>
              ))}
              <td>
                <button type="button" className="knowledge-db-delete" aria-label={t("knowledgeDbDeleteRow")} title={t("knowledgeDbDeleteRow")} onClick={() => onDeleteRow(row.id)}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <div className={inline ? "knowledge-db-inline" : "knowledge-page"}>
      {inline ? (
        <button type="button" className="knowledge-db-inline-title" onClick={() => onOpen(database.databaseId)}>
          🗂 {database.title || untitled}
        </button>
      ) : (
        <header className="knowledge-page-head">
          <h1>🗂 {database.title || untitled}</h1>
        </header>
      )}
      <div className="knowledge-db-toolbar">
        <div className="knowledge-db-views" role="tablist">
          {(Object.keys(viewLabels) as ViewKind[]).map((kind) => {
            const unavailable = (kind === "board" && groupable.length === 0) || (kind === "calendar" && !dateColumn);
            return (
              <button
                key={kind}
                type="button"
                role="tab"
                aria-selected={view.kind === kind}
                className={view.kind === kind ? "is-on" : ""}
                disabled={unavailable}
                title={unavailable ? t(kind === "board" ? "knowledgeDbBoardNeedsSelect" : "knowledgeDbCalendarNeedsDate") : undefined}
                onClick={() => setView({ kind })}
              >
                {t(viewLabels[kind])}
              </button>
            );
          })}
        </div>
        <div className="knowledge-db-tools">
          {view.kind === "board" && groupable.length > 1 ? (
            <select value={groupBy?.name ?? ""} onChange={(event) => setView({ groupBy: event.target.value })} aria-label={t("knowledgeDbGroupBy")}>
              {groupable.map((column) => (
                <option key={column.name} value={column.name}>
                  {t("knowledgeDbGroupBy")}:{column.name}
                </option>
              ))}
            </select>
          ) : null}
          <input
            className="knowledge-db-search"
            value={view.search}
            placeholder={t("knowledgeDbSearch")}
            onChange={(event) => setView({ search: event.target.value })}
          />
          <button type="button" className="nb-btn primary" onClick={() => onAddRow()}>
            {t("knowledgeDbNew")}
          </button>
        </div>
      </div>
      <div className="knowledge-db">
        {body}
        {view.kind === "table" || view.kind === "list" || view.kind === "gallery" ? (
          <button type="button" className="knowledge-db-add" onClick={() => onAddRow()}>
            ＋ {t("knowledgeDbAddRow")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 内嵌数据库要用的读写操作(由知识库页面提供)。 */
export interface DatabaseOps {
  load(databaseId: string): Promise<NotionDatabaseView | null>;
  cell(databaseId: string, rowId: string, property: string, value: CellValue): Promise<NotionDatabaseView>;
  addRow(databaseId: string, preset?: { property: string; value: CellValue }): Promise<NotionDatabaseView>;
  deleteRow(databaseId: string, rowId: string): Promise<NotionDatabaseView>;
  schema(databaseId: string, change: Parameters<Parameters<typeof DatabaseView>[0]["onSchema"]>[0]): Promise<NotionDatabaseView>;
  open(id: string): void;
  fail(error: unknown): void;
}

/** 页面里的内嵌数据库:取一次数据,之后的修改都就地更新。 */
export function InlineDatabase({ databaseId, title, ops, t, untitled }: { databaseId: string; title: string; ops: DatabaseOps; t: Translate; untitled: string }): ReactNode {
  const [database, setDatabase] = useState<NotionDatabaseView | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void ops
      .load(databaseId)
      .then((view) => alive && setDatabase(view))
      .catch(() => alive && setDatabase(null));
    return () => {
      alive = false;
    };
    // 只在换数据库时取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId]);
  if (!database) {
    return (
      <button type="button" className="nb-page-link" data-page-link={databaseId}>
        🗂 {title || untitled}
      </button>
    );
  }
  const apply = (promise: Promise<NotionDatabaseView>): void => {
    void promise.then(setDatabase).catch((error: unknown) => {
      ops.fail(error);
      void ops.load(databaseId).then(setDatabase).catch(() => undefined);
    });
  };
  return (
    <DatabaseView
      inline
      database={database}
      t={t}
      untitled={untitled}
      onOpen={ops.open}
      onCell={(rowId, property, value, display) => {
        setDatabase({
          ...database,
          rows: database.rows.map((row) =>
            row.id !== rowId
              ? row
              : {
                  ...row,
                  title: database.columns.find((column) => column.name === property)?.type === "title" ? display : row.title,
                  cells: row.cells.map((cell) => (cell.name === property ? { ...cell, text: display } : cell)),
                },
          ),
        });
        apply(ops.cell(databaseId, rowId, property, value));
      }}
      onAddRow={(preset) => apply(ops.addRow(databaseId, preset ? { property: preset.property, value: preset.value } : undefined))}
      onDeleteRow={(rowId) => {
        setDatabase({ ...database, rows: database.rows.filter((row) => row.id !== rowId) });
        apply(ops.deleteRow(databaseId, rowId));
      }}
      onSchema={(change) => apply(ops.schema(databaseId, change))}
    />
  );
}
