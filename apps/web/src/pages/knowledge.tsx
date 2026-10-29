import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  NotionDatabaseView,
  NotionPageView,
  NotionStatusView,
  NotionTreeNodeView,
} from "@you-brain/core/http/types.js";

import { Button } from "../components/button.js";
import { Icon } from "../components/icons.js";
import { useToast } from "../components/toast.js";
import { useDaemon } from "../daemon-context.js";
import { settingsHref } from "../lib/route.js";
import { useRoute } from "../router.js";
import { BlockList } from "./knowledge/blocks-view.js";
import { KindPicker, type BlockEditorCallbacks } from "./knowledge/block-editor.js";
import {
  firstNewBlockId,
  blockMarkdown,
  defaultPageId,
  fuzzyFilter,
  flattenTree,
  relativeTime,
  type FlatPage,
} from "./knowledge/logic.js";

interface KnowledgeCache {
  roots: NotionTreeNodeView[] | null;
  status: NotionStatusView | null;
  pageId: string | null;
  page: NotionPageView | null;
}

const CACHE_KEY = "you-brain:knowledge:v1";

function readKnowledgeCache(): KnowledgeCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return { roots: null, status: null, pageId: null, page: null };
    const parsed = JSON.parse(raw) as Partial<KnowledgeCache>;
    return {
      roots: Array.isArray(parsed.roots) ? parsed.roots : null,
      status: parsed.status ?? null,
      pageId: typeof parsed.pageId === "string" ? parsed.pageId : null,
      page: parsed.page ?? null,
    };
  } catch {
    return { roots: null, status: null, pageId: null, page: null };
  }
}

function writeKnowledgeCache(patch: Partial<KnowledgeCache>): void {
  try {
    const current = readKnowledgeCache();
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...current, ...patch }));
  } catch {
    // 隐私模式等写不进就算了,只影响下次的秒开。
  }
}

export function KnowledgePage() {
  const { client, t, language } = useDaemon();
  const { push } = useToast();
  const { location, navigate } = useRoute();
  const cached = useRef(readKnowledgeCache());

  const [status, setStatus] = useState<NotionStatusView | null>(cached.current.status);
  const [roots, setRoots] = useState<NotionTreeNodeView[] | null>(cached.current.roots);
  const [page, setPage] = useState<NotionPageView | null>(null);
  const [database, setDatabase] = useState<NotionDatabaseView | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Array<{ pageId: string; title: string; excerpt: string }> | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedId = location.id;

  const refreshMeta = useCallback(async () => {
    const nextStatus = await client.notionStatus();
    setStatus(nextStatus);
    if (nextStatus.hasToken) {
      const tree = await client.notionTree();
      setRoots(tree.roots);
      writeKnowledgeCache({ status: nextStatus, roots: tree.roots });
    } else {
      setRoots([]);
      writeKnowledgeCache({ status: nextStatus, roots: [] });
    }
    return nextStatus;
  }, [client]);

  useEffect(() => {
    let alive = true;
    void refreshMeta().catch(() => {
      // 刷新失败时保留缓存渲染;完全没有缓存才落到空态。
      if (alive && roots === null) setRoots([]);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshMeta]);

  // 打开选中的页面或数据库。
  useEffect(() => {
    let alive = true;
    if (!selectedId) {
      setPage(null);
      setDatabase(null);
      return;
    }
    // 秒开:缓存里正好是这一页就先渲染,下面的请求继续刷新。
    if (
      cached.current.pageId === selectedId &&
      cached.current.page &&
      page === null &&
      !loading
    ) {
      setPage(cached.current.page);
    }
    setLoading(true);
    void (async () => {
      try {
        const node = findNode(roots ?? [], selectedId);
        if (node?.object === "database") {
          const db = await client.notionDatabase(selectedId);
          if (!alive) return;
          setDatabase(db);
          setPage(null);
        } else {
          const detail = await client.notionPage(selectedId);
          if (!alive) return;
          setPage(detail);
          setDatabase(null);
          writeKnowledgeCache({ pageId: selectedId, page: detail });
        }
      } catch {
        if (alive) {
          setPage(null);
          setDatabase(null);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, roots, selectedId]);

  const open = useCallback(
    (id: string) => {
      navigate(`/knowledge?id=${encodeURIComponent(id)}`);
    },
    [navigate],
  );

  // 首次进入自动打开第一篇。
  useEffect(() => {
    if (selectedId || roots === null || roots.length === 0) return;
    const first = defaultPageId(roots);
    if (first) open(first);
  }, [open, roots, selectedId]);

  const runSync = useCallback(async () => {
    setSyncing(true);
    try {
      const summary = await client.notionSync();
      await refreshMeta();
      push({
        message:
          summary.pending > 0
            ? t("knowledgeSyncDone", { pages: summary.pagesSynced, pending: summary.pending })
            : t("knowledgeSyncDone", { pages: summary.pagesSynced, pending: 0 }),
        tone: "success",
      });
      if (selectedId) open(selectedId);
    } catch (error) {
      push({
        message: t("knowledgeSyncFailed", { error: error instanceof Error ? error.message : String(error) }),
        tone: "danger",
      });
    } finally {
      setSyncing(false);
    }
  }, [client, open, push, refreshMeta, selectedId, t]);

  // 侧栏搜索:防抖走 daemon FTS。
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setHits(null);
      return;
    }
    const timer = setTimeout(() => {
      void client
        .notionSearch(trimmed, 20)
        .then((result) => setHits(result.hits))
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [client, query]);

  // ⌘P / ⌘O 快速切换。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "p" || event.key === "o") {
        event.preventDefault();
        setSwitcherOpen((value) => !value);
      }
      if (event.key === "Escape") setSwitcherOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // —— 编辑回调:每次写操作都返回刷新后的页面,直接替换本地视图 ——
  const [editingId, setEditingId] = useState<string | null>(null);

  const editor: BlockEditorCallbacks = useMemo(() => {
    const run = async <T extends { page: NotionPageView }>(action: () => Promise<T>): Promise<void> => {
      if (!page) return;
      setBusy(true);
      try {
        const result = await action();
        const created = firstNewBlockId(page.blocks, result.page.blocks);
        setPage(result.page);
        if (created) setEditingId(created);
      } catch (error) {
        push({
          message: error instanceof Error ? error.message : String(error),
          tone: "danger",
        });
      } finally {
        setBusy(false);
      }
    };
    return {
      busy,
      update: (blockId, markdown, kind, checked) =>
        run(() =>
          client.notionUpdateBlock({
            blockId,
            markdown,
            ...(kind ? { kind } : {}),
            ...(checked === undefined ? {} : { checked }),
          }),
        ),
      remove: (blockId) => run(() => client.notionDeleteBlock({ blockId })),
      move: (blockId, direction) => run(() => client.notionMoveBlock({ blockId, direction })),
      duplicate: (blockId) => run(() => client.notionDuplicateBlock({ blockId })),
      toggleTodo: (block) => {
        if (block.kind !== "todo") return Promise.resolve();
        return run(() =>
          client.notionUpdateBlock({
            blockId: block.id,
            markdown: blockMarkdown(block),
            checked: !block.checked,
          }),
        );
      },
      addBelow: (afterBlockId, kind) =>
        run(() =>
          client.notionAppendBlock({
            ...(afterBlockId ? { afterBlockId } : { pageId: page?.id ?? "" }),
            markdown: "",
            kind,
          }),
        ),
    };
  }, [busy, client, page, push]);

  const flat = useMemo(() => flattenTree(roots ?? []), [roots]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (status !== null && !status.hasToken) {
    return (
      <div className="page knowledge-empty">
        <div className="empty-card">
          <h1>{t("knowledgeEmptyTitle")}</h1>
          <p>{t("knowledgeEmptyBody")}</p>
          <Button onClick={() => navigate(settingsHref("integrations"))}>{t("knowledgeEmptyAction")}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="knowledge">
      <aside className="knowledge-sidebar">
        <input
          className="knowledge-search"
          type="search"
          placeholder={t("knowledgeSidebarSearch")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <nav className="knowledge-tree" aria-label={t("navKnowledge")}>
          {hits !== null ? (
            <div className="knowledge-search-results">
              <div className="knowledge-tree-section">{t("knowledgeSearchResults")}</div>
              {hits.length === 0 ? (
                <p className="knowledge-hint">{t("knowledgeSearchNoHits", { query: query.trim() })}</p>
              ) : (
                hits.map((hit) => (
                  <button
                    key={hit.pageId}
                    type="button"
                    className={"knowledge-tree-item" + (hit.pageId === selectedId ? " is-active" : "")}
                    onClick={() => open(hit.pageId)}
                    title={hit.excerpt}
                  >
                    <span className="knowledge-tree-title">📄 {hit.title || t("knowledgeUntitled")}</span>
                  </button>
                ))
              )}
            </div>
          ) : roots === null ? (
            <p className="knowledge-hint">{t("knowledgeLoading")}</p>
          ) : roots.length === 0 ? (
            <p className="knowledge-hint">{t("knowledgeEmptySync")}</p>
          ) : (
            <TreeNodes
              nodes={roots}
              selectedId={selectedId ?? null}
              collapsed={collapsed}
              onToggle={toggleCollapse}
              onOpen={open}
              untitled={t("knowledgeUntitled")}
            />
          )}
        </nav>
        <footer className="knowledge-footer">
          <div className="knowledge-footer-meta">
            {status
              ? t(status.lastSyncAt ? "knowledgeLastSync" : "knowledgeNeverSynced", {
                  time: relativeTime(status.lastSyncAt, new Date(), language),
                  count: status.pages,
                })
              : null}
          </div>
          <div className="knowledge-footer-actions">
            <button
              type="button"
              className="knowledge-switcher-trigger"
              onClick={() => setSwitcherOpen(true)}
            >
              <Icon name="search" size={12} /> ⌘P
            </button>
            <Button size="sm" onClick={() => void runSync()} disabled={syncing}>
              {syncing ? t("knowledgeSyncing") : t("knowledgeSyncNow")}
            </Button>
          </div>
        </footer>
      </aside>
      <section className="knowledge-main">
        {database ? (
          <DatabaseView database={database} onOpen={open} untitled={t("knowledgeUntitled")} />
        ) : page ? (
          <article className="knowledge-page">
            {page.coverUrl ? <div className="knowledge-cover" /> : null}
            <header className="knowledge-page-head">
              {page.icon ? <span className="knowledge-page-icon">{page.icon}</span> : null}
              {titleEditing ? (
                <form
                  className="knowledge-title-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (titleDraft.trim() === "" || !page) return;
                    setBusy(true);
                    void client
                      .notionPatchTitle({ pageId: page.id, title: titleDraft.trim() })
                      .then((result) => {
                        setPage(result.page);
                        setTitleEditing(false);
                      })
                      .catch((error) =>
                        push({
                          message: error instanceof Error ? error.message : String(error),
                          tone: "danger",
                        }),
                      )
                      .finally(() => setBusy(false));
                  }}
                >
                  <input
                    className="knowledge-title-input"
                    value={titleDraft}
                    autoFocus
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setTitleEditing(false);
                    }}
                  />
                </form>
              ) : (
                <h1
                  className="knowledge-title-editable"
                  title={t("knowledgeEdit")}
                  onClick={() => {
                    setTitleDraft(page.title);
                    setTitleEditing(true);
                  }}
                >
                  {page.title}
                </h1>
              )}
              {page.properties && Object.keys(page.properties).length > 0 ? (
                <dl className="knowledge-properties">
                  {Object.entries(page.properties).map(([name, value]) => (
                    <div key={name} className="knowledge-property">
                      <dt>{name}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </header>
            <div className="knowledge-blocks">
              <BlockList
                blocks={page.blocks}
                t={t}
                assetBase={(blockId) => client.notionAssetUrl(blockId)}
                editor={editor}
                editingId={editingId}
              />
              <div className="knowledge-add-block">
                {addOpen ? (
                  <KindPicker
                    t={t}
                    allowDivider
                    onPick={(kind) => {
                      setAddOpen(false);
                      void editor.addBelow(null, kind);
                    }}
                    onClose={() => setAddOpen(false)}
                  />
                ) : (
                  <button type="button" className="knowledge-add-trigger" onClick={() => setAddOpen(true)}>
                    ＋ {t("knowledgeAddBlock")}
                  </button>
                )}
              </div>
            </div>
            <footer className="knowledge-page-foot">{t("knowledgeBacklinksHint")}</footer>
          </article>
        ) : loading ? (
          <p className="knowledge-hint">{t("knowledgeLoading")}</p>
        ) : selectedId ? (
          <div className="empty-card">
            <h1>{t("knowledgePageMissing")}</h1>
            <Button size="sm" onClick={() => void runSync()} disabled={syncing}>
              {syncing ? t("knowledgeSyncing") : t("knowledgeSyncNow")}
            </Button>
          </div>
        ) : null}
      </section>
      {switcherOpen ? (
        <Switcher
          pages={flat}
          onPick={(id) => {
            setSwitcherOpen(false);
            open(id);
          }}
          onClose={() => setSwitcherOpen(false)}
          placeholder={t("knowledgeSwitcherHint")}
          emptyText={t("knowledgeSwitcherEmpty")}
        />
      ) : null}
    </div>
  );
}

function TreeNodes({
  nodes,
  selectedId,
  collapsed,
  onToggle,
  onOpen,
  depth = 0,
  untitled,
}: {
  nodes: readonly NotionTreeNodeView[];
  selectedId: string | null;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  depth?: number;
  untitled: string;
}): ReactNode {
  return (
    <>
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const isCollapsed = collapsed.has(node.id);
        return (
          <div key={node.id}>
            <div className="knowledge-tree-row" style={{ paddingLeft: `${8 + depth * 14}px` }}>
              {hasChildren ? (
                <button
                  type="button"
                  className={"knowledge-caret" + (isCollapsed ? " is-collapsed" : "")}
                  aria-label={node.title}
                  onClick={() => onToggle(node.id)}
                >
                  ▸
                </button>
              ) : (
                <span className="knowledge-caret is-leaf" />
              )}
              <button
                type="button"
                className={"knowledge-tree-item" + (node.id === selectedId ? " is-active" : "")}
                onClick={() => onOpen(node.id)}
              >
                <span className="knowledge-tree-title">
                  {node.icon ?? (node.object === "database" ? "🗂" : "📄")} {node.title || untitled}
                </span>
              </button>
            </div>
            {hasChildren && !isCollapsed ? (
              <TreeNodes
                nodes={node.children}
                selectedId={selectedId}
                collapsed={collapsed}
                onToggle={onToggle}
                onOpen={onOpen}
                depth={depth + 1}
                untitled={untitled}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function Switcher({
  pages,
  onPick,
  onClose,
  placeholder,
  emptyText,
}: {
  pages: readonly FlatPage[];
  onPick: (id: string) => void;
  onClose: () => void;
  placeholder: string;
  emptyText: string;
}) {
  const [input, setInput] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => fuzzyFilter(pages, input), [pages, input]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setActive(0);
  }, [input]);
  return (
    <div className="knowledge-scrim" onClick={onClose} role="presentation">
      <div
        className="knowledge-switcher"
        role="dialog"
        aria-label={placeholder}
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          className="knowledge-switcher-input"
          placeholder={placeholder}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((value) => Math.min(value + 1, results.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((value) => Math.max(value - 1, 0));
            } else if (event.key === "Enter") {
              const picked = results[active];
              if (picked) onPick(picked.id);
            } else if (event.key === "Escape") {
              onClose();
            }
          }}
        />
        <ul className="knowledge-switcher-list">
          {results.map((page, index) => (
            <li key={page.id}>
              <button
                type="button"
                className={index === active ? "is-active" : ""}
                onMouseEnter={() => setActive(index)}
                onClick={() => onPick(page.id)}
              >
                {page.icon ?? (page.object === "database" ? "🗂" : "📄")} {page.title}
              </button>
            </li>
          ))}
          {results.length === 0 ? <li className="knowledge-hint">{emptyText}</li> : null}
        </ul>
      </div>
    </div>
  );
}

function DatabaseView({
  database,
  onOpen,
  untitled,
}: {
  database: NotionDatabaseView;
  onOpen: (id: string) => void;
  untitled: string;
}) {
  return (
    <div className="knowledge-page">
      <header className="knowledge-page-head">
        <h1>🗂 {database.title || untitled}</h1>
      </header>
      {database.rows.length === 0 ? (
        <p className="knowledge-hint">·</p>
      ) : (
        <div className="knowledge-db">
          <table className="nb-table knowledge-db-table">
            <thead>
              <tr>
                <th />
                {database.columns.map((column) => (
                  <th key={column.name}>
                    {column.name} <span className="knowledge-db-type">{column.type}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {database.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <button type="button" className="knowledge-db-title" onClick={() => onOpen(row.id)}>
                      {row.icon ?? "📄"} {row.title || untitled}
                    </button>
                  </td>
                  {database.columns.map((column) => {
                    const cell = row.cells.find((candidate) => candidate.name === column.name);
                    return <td key={column.name}>{cell?.text || ""}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function findNode(nodes: readonly NotionTreeNodeView[], id: string): NotionTreeNodeView | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findNode(node.children, id);
    if (nested) return nested;
  }
  return null;
}
