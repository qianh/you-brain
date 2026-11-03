import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import type {
  NotionBlockModel,
  NotionDatabaseView,
  NotionPageView,
  NotionSegment,
  NotionStatusView,
  NotionTreeNodeView,
} from "@you-brain/core/http/types.js";

import { Button } from "../components/button.js";
import { ConfirmDialog, Dialog } from "../components/dialog.js";
import { Icon } from "../components/icons.js";
import { Input } from "../components/input.js";
import { useToast } from "../components/toast.js";
import { useDaemon } from "../daemon-context.js";
import { useImeGuard } from "../lib/ime-guard.js";
import { settingsHref } from "../lib/route.js";
import { useRoute } from "../router.js";
import { BlockList } from "./knowledge/blocks-view.js";
import { type BlockEditorCallbacks, type FocusRequest, type Translate } from "./knowledge/block-editor.js";
import {
  LOCAL_ID_PREFIX,
  blockMarkdown,
  convertBlock,
  defaultPageId,
  findBlockIn,
  flattenTree,
  fuzzyFilter,
  hasSegments,
  insertAfterIn,
  indentIn,
  isLocalId,
  lastChildOf,
  locateNewBlockId,
  locateNewBlocks,
  outdentIn,
  pairBlockIds,
  pastedToAppend,
  pastedToLocal,
  plainSegments,
  blockToAppend,
  canDropPage,
  moveNodeIn,
  type AppendChild,
  makeLocalBlock,
  relativeTime,
  remapBlockIds,
  removeBlockIn,
  segmentsText,
  updateBlockIn,
  withSegments,
  type FlatPage,
  type TurnIntoKind,
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

const COLLAPSED_KEY = "you-brain:knowledge:collapsed:v1";

function readCollapsed(): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    // 写不进就只在本次会话内有效。
  }
}

export function KnowledgePage() {
  const { client, t, language } = useDaemon();
  const { push } = useToast();
  const { location, navigate } = useRoute();
  const titleIme = useImeGuard();
  const cached = useRef(readKnowledgeCache());

  const [status, setStatus] = useState<NotionStatusView | null>(cached.current.status);
  const [roots, setRoots] = useState<NotionTreeNodeView[] | null>(cached.current.roots);
  const [page, setPage] = useState<NotionPageView | null>(null);
  // 页面的同步镜像:编辑回调在同一事件里连续读写,不能等 React 渲染。
  const pageRef = useRef<NotionPageView | null>(null);
  const selectedRef = useRef<string | null>(null);
  const commitPage = useCallback((next: NotionPageView | null): void => {
    pageRef.current = next;
    setPage(next);
  }, []);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");
  // 移动/复制要等 Notion 重排后才能显示,期间禁用这类菜单项。
  const [structBusy, setStructBusy] = useState(false);
  const [database, setDatabase] = useState<NotionDatabaseView | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Array<{ pageId: string; title: string; excerpt: string }> | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // 侧栏折叠状态要记住:重新进入知识库时保持上次收起/展开的样子。
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(readCollapsed);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  // Tauri 的 WKWebView 不支持 window.confirm/prompt,确认与改名走 Dialog。
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [rename, setRename] = useState<{ id: string; current: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const raw = Number(localStorage.getItem("knowledge-sidebar-w"));
    return Number.isFinite(raw) && raw >= 200 && raw <= 520 ? raw : 264;
  });
  const [resizing, setResizing] = useState(false);
  const startResize = (event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const clamp = (value: number): number => Math.min(520, Math.max(200, value));
    const onMove = (move: MouseEvent): void => setSidebarWidth(clamp(startWidth + move.clientX - startX));
    const onUp = (move: MouseEvent): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setResizing(false);
      localStorage.setItem("knowledge-sidebar-w", String(clamp(startWidth + move.clientX - startX)));
    };
    setResizing(true);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

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

  // 标题编辑框:点外面就收起(丢弃未保存的草稿,Esc 亦同)。
  useEffect(() => {
    if (!titleEditing) return;
    const onDown = (event: MouseEvent): void => {
      const form = document.querySelector(".knowledge-title-form");
      if (form && !form.contains(event.target as Node)) setTitleEditing(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [titleEditing]);

  // 打开选中的页面或数据库。
  useEffect(() => {
    let alive = true;
    if (!selectedId) {
      commitPage(null);
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
      commitPage(cached.current.page);
    }
    setLoading(true);
    void (async () => {
      try {
        const node = findNode(roots ?? [], selectedId);
        if (node?.object === "database") {
          const db = await client.notionDatabase(selectedId);
          if (!alive) return;
          setDatabase(db);
          commitPage(null);
        } else {
          // 先等在途的保存落地,再拉取,否则会读到还没写入的旧内容。
          await queue.current;
          const detail = await client.notionPage(selectedId);
          if (!alive) return;
          setDatabase(null);
          writeKnowledgeCache({ pageId: selectedId, page: detail });
          // 正在这一页里打字时不整页替换(目录刷新也会触发这里),否则光标会被打断。
          if (pageRef.current?.id === selectedId && (pendingJobs.current > 0 || isEditingBlocks())) return;
          sentText.current.clear();
          commitPage(detail);
        }
      } catch {
        if (alive) {
          commitPage(null);
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

  // —— 编辑:乐观更新 + 串行后台保存 ——
  // Notion 式手感:先改本地块树(立刻可见、光标不动),再由一条串行队列写回 Notion。
  // 队列里新建的块先用本地 id;Notion 返回后登记真实 id,后续操作按本地 id 解析。
  selectedRef.current = selectedId;
  const localSeq = useRef(0);
  const localToReal = useRef(new Map<string, string>());
  const realToLocal = useRef(new Map<string, string>());
  const sentText = useRef(new Map<string, string>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pendingJobs = useRef(0);
  const pendingStructural = useRef(0);
  const needAdopt = useRef(false);
  const failedJob = useRef(false);
  const lastServer = useRef<NotionPageView | null>(null);

  const newLocalId = useCallback((): string => {
    localSeq.current += 1;
    return `${LOCAL_ID_PREFIX}${localSeq.current}`;
  }, []);
  const realId = useCallback(
    (id: string): string | null =>
      localToReal.current.get(id) ?? (isLocalId(id) ? null : id),
    [],
  );
  const learnId = useCallback((localId: string, serverId: string): void => {
    localToReal.current.set(localId, serverId);
    realToLocal.current.set(serverId, localId);
  }, []);
  /** 本地块树里的最新状态(任务真正执行时再读,保证写的是最新文本)。 */
  const liveBlock = useCallback(
    (id: string, fallback: NotionBlockModel): NotionBlockModel =>
      findBlockIn(pageRef.current?.blocks ?? [], id) ?? fallback,
    [],
  );
  const requestFocus = useCallback((blockId: string, at: FocusRequest["at"]): void => {
    setFocus({ blockId, at });
  }, []);
  // 请求的块若始终没出现(例如已被删除),别让它在以后意外抢走光标。
  useEffect(() => {
    if (focus === null) return;
    const timer = setTimeout(() => setFocus(null), 1500);
    return () => clearTimeout(timer);
  }, [focus]);

  const enqueue = useCallback(
    (
      pageId: string,
      job: () => Promise<NotionPageView | null>,
      options?: { structural?: boolean },
    ): void => {
      pendingJobs.current += 1;
      if (options?.structural) {
        pendingStructural.current += 1;
        setStructBusy(true);
      }
      setSaveState("saving");
      queue.current = queue.current
        .then(async () => {
          const view = await job();
          if (view) lastServer.current = view;
          if (options?.structural) needAdopt.current = true;
        })
        .catch((error: unknown) => {
          failedJob.current = true;
          needAdopt.current = true;
          push({
            message: error instanceof Error ? error.message : String(error),
            tone: "danger",
          });
        })
        .then(async () => {
          pendingJobs.current -= 1;
          if (options?.structural) {
            pendingStructural.current -= 1;
            if (pendingStructural.current === 0) setStructBusy(false);
          }
          if (pendingJobs.current > 0) return;
          const failed = failedJob.current;
          const adopt = needAdopt.current;
          failedJob.current = false;
          needAdopt.current = false;
          setSaveState(failed ? "error" : "idle");
          const known = lastServer.current?.id === pageId ? lastServer.current : null;
          if (!failed && known) writeKnowledgeCache({ pageId, page: known });
          if (!adopt) return;
          // 失败或移动/复制:以 Notion 为准重建本地视图(沿用本地 id,行不重挂载)。
          try {
            const view = failed || !known ? await client.notionPage(pageId) : known;
            if (view && selectedRef.current === pageId) {
              sentText.current.clear();
              commitPage({ ...view, blocks: remapBlockIds(view.blocks, realToLocal.current) });
              writeKnowledgeCache({ pageId, page: view });
            }
          } catch {
            // 下次打开页面会重新拉取。
          }
        });
    },
    [client, commitPage, push],
  );

  /** 改本地块树并同步到 pageRef;返回改之前的页面(没有页面则 null)。 */
  const editLocal = useCallback(
    (change: (blocks: NotionBlockModel[]) => NotionBlockModel[]): NotionPageView | null => {
      const current = pageRef.current;
      if (!current) return null;
      commitPage({ ...current, blocks: change(current.blocks) });
      return current;
    },
    [commitPage],
  );

  const editor: BlockEditorCallbacks = useMemo(() => {
    const syncText = (pageId: string, blockId: string): void => {
      enqueue(pageId, async () => {
        const real = realId(blockId);
        const live = pageRef.current ? findBlockIn(pageRef.current.blocks, blockId) : null;
        if (!real || !live || !hasSegments(live)) return null;
        const json = JSON.stringify(live.segments);
        if (sentText.current.get(blockId) === json) return null;
        sentText.current.set(blockId, json);
        const result = await client.notionUpdateBlock({ blockId: real, markdown: "", rich: live.segments });
        return result.page;
      });
    };
    const removeBlock = (blockId: string, focusId?: string | null): void => {
      const before = editLocal((blocks) => removeBlockIn(blocks, blockId));
      if (!before) return;
      if (focusId) requestFocus(focusId, "end");
      enqueue(before.id, async () => {
        const real = realId(blockId);
        if (!real) return null;
        return (await client.notionDeleteBlock({ blockId: real })).page;
      });
    };
    /**
     * 在 anchor 处重建一份块(带整棵子树)再删掉原块,并把副本的真实 id 登记给原本地 id。
     * Notion 没有「移动」也不允许改块类型(PATCH 换类型会报 Block type mismatch),
     * 转类型、缩进、反缩进都只能这样:新建 + 删除。
     */
    const recreate = (
      pageId: string,
      blockId: string,
      anchor: { parentId: string } | { afterId: string },
    ): void => {
      enqueue(pageId, async () => {
        const oldReal = realId(blockId);
        const anchorId = "parentId" in anchor ? anchor.parentId : anchor.afterId;
        const anchorReal = realId(anchorId);
        const live = findBlockIn(pageRef.current?.blocks ?? [], blockId);
        if (!oldReal || !anchorReal || !live) return null;
        const payload = blockToAppend(live);
        // 子树里有图片/表格等没法重建的块:宁可报错并回到 Notion 的版本,也不能静默丢内容。
        if (!payload) throw new Error("这个块带有无法重建的子块(图片、表格等),暂不支持转类型或缩进");
        const result = await client.notionAppendBlock({
          ...("parentId" in anchor ? { parentBlockId: anchorReal } : { afterBlockId: anchorReal }),
          markdown: "",
          children: [payload],
        });
        const copy =
          "parentId" in anchor
            ? lastChildOf(result.page.blocks, anchorReal)
            : locateNewBlocks(result.page.blocks, anchorReal, 1)[0];
        if (copy) for (const [localId, serverId] of pairBlockIds([live], [copy])) learnId(localId, serverId);
        sentText.current.delete(blockId);
        return (await client.notionDeleteBlock({ blockId: oldReal })).page;
      });
    };
    const convert = (block: NotionBlockModel, kind: TurnIntoKind): void => {
      const live = liveBlock(block.id, block);
      const before = editLocal((blocks) => updateBlockIn(blocks, live.id, (entry) => convertBlock(entry, kind)));
      if (!before) return;
      // 转成代码块后直接进入编辑(代码块没有行内光标,空的更点不到)。
      if (kind === "code") requestFocus(block.id, "start");
      recreate(before.id, block.id, { afterId: block.id });
    };
    /**
     * 缩进/反缩进:本地立刻换位置;Notion 没有移动接口,所以在新位置建一份副本(带整棵子树)
     * 再删掉原块,并把副本的真实 id 登记给原来的本地 id,后续操作不受影响。
     */
    const relocate = (
      current: NotionPageView,
      nextBlocks: NotionBlockModel[],
      blockId: string,
      caret: number | undefined,
      target: { parentId: string } | { afterId: string },
    ): Promise<void> => {
      if (!findBlockIn(nextBlocks, blockId)) return Promise.resolve();
      commitPage({ ...current, blocks: nextBlocks });
      requestFocus(blockId, caret ?? "end");
      recreate(current.id, blockId, target);
      return Promise.resolve();
    };
    return {
      busy: structBusy,
      focus,
      onFocusHandled: () => setFocus(null),
      saveSegments: (block, segments) => {
        const live = liveBlock(block.id, block);
        if (!hasSegments(live)) return Promise.resolve();
        if (JSON.stringify(live.segments) === JSON.stringify(segments)) return Promise.resolve();
        const before = editLocal((blocks) =>
          updateBlockIn(blocks, block.id, (entry) => withSegments(entry, segments)),
        );
        if (before) syncText(before.id, block.id);
        return Promise.resolve();
      },
      saveCode: (blockId, text, language) => {
        const before = editLocal((blocks) =>
          updateBlockIn(blocks, blockId, (entry) =>
            entry.kind === "code" ? { ...entry, text, ...(language ? { language } : {}) } : entry,
          ),
        );
        if (!before) return Promise.resolve();
        enqueue(before.id, async () => {
          const real = realId(blockId);
          if (!real) return null;
          const result = await client.notionUpdateBlock({
            blockId: real,
            markdown: text,
            ...(language ? { language } : {}),
          });
          return result.page;
        });
        return Promise.resolve();
      },
      remove: (blockId, focusId) => {
        removeBlock(blockId, focusId);
        return Promise.resolve();
      },
      move: (blockId, direction) => {
        const current = pageRef.current;
        if (!current) return Promise.resolve();
        enqueue(
          current.id,
          async () => {
            const real = realId(blockId);
            if (!real) return null;
            return (await client.notionMoveBlock({ blockId: real, direction })).page;
          },
          { structural: true },
        );
        return Promise.resolve();
      },
      duplicate: (blockId) => {
        const current = pageRef.current;
        if (!current) return Promise.resolve();
        enqueue(
          current.id,
          async () => {
            const real = realId(blockId);
            if (!real) return null;
            return (await client.notionDuplicateBlock({ blockId: real })).page;
          },
          { structural: true },
        );
        return Promise.resolve();
      },
      toggleTodo: (block) => {
        const live = liveBlock(block.id, block);
        if (live.kind !== "todo") return Promise.resolve();
        const checked = !live.checked;
        const before = editLocal((blocks) =>
          updateBlockIn(blocks, block.id, (entry) => (entry.kind === "todo" ? { ...entry, checked } : entry)),
        );
        if (!before) return Promise.resolve();
        enqueue(before.id, async () => {
          const real = realId(block.id);
          if (!real) return null;
          const now = liveBlock(block.id, live);
          const rich = hasSegments(now) ? now.segments : [];
          sentText.current.set(block.id, JSON.stringify(rich));
          const result = await client.notionUpdateBlock({ blockId: real, markdown: "", rich, checked });
          return result.page;
        });
        return Promise.resolve();
      },
      addBelow: (afterBlockId, kind) => {
        const id = newLocalId();
        const trailingId = kind === "divider" ? newLocalId() : null;
        const before = editLocal((blocks) => {
          const next = insertAfterIn(blocks, afterBlockId, makeLocalBlock(id, kind));
          return trailingId ? insertAfterIn(next, id, makeLocalBlock(trailingId, "paragraph")) : next;
        });
        if (!before) return Promise.resolve();
        // 分隔线没有文本:光标落到它下面新补的空段落。
        requestFocus(trailingId ?? id, "start");
        enqueue(before.id, async () => {
          const after = afterBlockId === null ? null : realId(afterBlockId);
          if (afterBlockId !== null && !after) return null;
          const first = await client.notionAppendBlock({
            ...(after ? { afterBlockId: after } : { pageId: before.id }),
            markdown: "",
            kind,
          });
          const created = locateNewBlockId(first.page.blocks, after);
          if (created) learnId(id, created);
          if (!trailingId || !created) return first.page;
          const second = await client.notionAppendBlock({
            afterBlockId: created,
            markdown: "",
            kind: "paragraph",
          });
          const trailing = locateNewBlockId(second.page.blocks, created);
          if (trailing) learnId(trailingId, trailing);
          return second.page;
        });
        return Promise.resolve();
      },
      split: (block, head, tail) => {
        const live = liveBlock(block.id, block);
        const bare = (segments: NotionSegment[]): boolean => segments.every((segment) => segment.text === "");
        // Notion:空的列表项/待办上回车 = 退出列表,变回普通段落。
        if (
          bare(head) &&
          bare(tail) &&
          (live.kind === "bulleted" || live.kind === "numbered" || live.kind === "todo")
        ) {
          convert(live, "paragraph");
          requestFocus(block.id, "start");
          return Promise.resolve();
        }
        const kind =
          live.kind === "heading"
            ? ("paragraph" as const)
            : (live.kind as "paragraph" | "bulleted" | "numbered" | "todo" | "quote" | "callout" | "toggle");
        const id = newLocalId();
        const before = editLocal((blocks) =>
          insertAfterIn(
            updateBlockIn(blocks, block.id, (entry) => withSegments(entry, head)),
            block.id,
            makeLocalBlock(id, kind, tail),
          ),
        );
        if (!before) return Promise.resolve();
        requestFocus(id, "start");
        enqueue(before.id, async () => {
          const real = realId(block.id);
          if (!real) return null;
          sentText.current.set(block.id, JSON.stringify(head));
          await client.notionUpdateBlock({ blockId: real, markdown: "", rich: head });
          const result = await client.notionAppendBlock({
            afterBlockId: real,
            markdown: "",
            kind,
            rich: tail,
          });
          const created = locateNewBlockId(result.page.blocks, real);
          if (created) learnId(id, created);
          return result.page;
        });
        return Promise.resolve();
      },
      merge: (block, prevId) => {
        const current = pageRef.current;
        if (!current) return Promise.resolve();
        const prev = findBlockIn(current.blocks, prevId);
        const live = liveBlock(block.id, block);
        if (!prev || !hasSegments(prev) || !hasSegments(live) || live.children.length > 0) {
          // 前一块不是文本块(或本块带子块):空块直接删,有字的不动,避免误伤。
          if (hasSegments(live) && segmentsText(live.segments) === "") removeBlock(block.id, prevId);
          else if (prev) requestFocus(prevId, "end");
          return Promise.resolve();
        }
        const prevLength = segmentsText(prev.segments).length;
        const merged = [...prev.segments, ...live.segments.filter((segment) => segment.text !== "")];
        const before = editLocal((blocks) =>
          removeBlockIn(
            updateBlockIn(blocks, prevId, (entry) => withSegments(entry, merged)),
            block.id,
          ),
        );
        if (!before) return Promise.resolve();
        requestFocus(prevId, prevLength);
        enqueue(before.id, async () => {
          const realPrev = realId(prevId);
          const real = realId(block.id);
          if (!realPrev || !real) return null;
          sentText.current.set(prevId, JSON.stringify(merged));
          await client.notionUpdateBlock({ blockId: realPrev, markdown: "", rich: merged });
          return (await client.notionDeleteBlock({ blockId: real })).page;
        });
        return Promise.resolve();
      },
      turnInto: (block, kind) => {
        convert(block, kind);
        return Promise.resolve();
      },
      paste: (block, head, items, tail) => {
        const live = liveBlock(block.id, block);
        const tailKind =
          live.kind === "heading"
            ? ("paragraph" as const)
            : (live.kind as "paragraph" | "bulleted" | "numbered" | "todo" | "quote" | "callout" | "toggle");
        const hasTail = tail.some((segment) => segment.text !== "");
        const added = pastedToLocal(items, newLocalId);
        if (hasTail) added.push(makeLocalBlock(newLocalId(), tailKind, tail));
        const before = editLocal((blocks) => {
          let next = head ? updateBlockIn(blocks, block.id, (entry) => withSegments(entry, head)) : blocks;
          let after = block.id;
          for (const entry of added) {
            next = insertAfterIn(next, after, entry);
            after = entry.id;
          }
          return head === null ? removeBlockIn(next, block.id) : next;
        });
        if (!before) return Promise.resolve();
        // 光标落在粘贴内容的最后一个文本块末尾(嵌套的取最深的最后一个)。
        const lastLeaf = (list: readonly NotionBlockModel[]): NotionBlockModel | null => {
          for (let i = list.length - 1; i >= 0; i -= 1) {
            const entry = list[i];
            if (!entry) continue;
            const nested = lastLeaf(entry.children);
            if (nested) return nested;
            if (hasSegments(entry)) return entry;
          }
          return null;
        };
        const focusTarget = lastLeaf(hasTail ? added.slice(0, -1) : added);
        if (focusTarget) requestFocus(focusTarget.id, "end");
        const children: AppendChild[] = [
          ...pastedToAppend(items),
          ...(hasTail ? [{ kind: tailKind, markdown: "", rich: tail }] : []),
        ];
        enqueue(before.id, async () => {
          let afterReal = realId(block.id);
          if (!afterReal) return null;
          const firstReal = afterReal;
          if (head) {
            sentText.current.set(block.id, JSON.stringify(head));
            await client.notionUpdateBlock({ blockId: afterReal, markdown: "", rich: head });
          }
          let view: NotionPageView | null = null;
          // Notion 单次最多追加 100 个块;每批接在上一批最后一个块之后。
          for (let start = 0; start < children.length; start += 100) {
            const batch = children.slice(start, start + 100);
            const result = await client.notionAppendBlock({ afterBlockId: afterReal, markdown: "", children: batch });
            view = result.page;
            const created = locateNewBlocks(result.page.blocks, afterReal, batch.length);
            for (const [localId, serverId] of pairBlockIds(added.slice(start, start + batch.length), created)) {
              learnId(localId, serverId);
            }
            const last = created[created.length - 1];
            if (!last) break;
            afterReal = last.id;
          }
          if (head === null) view = (await client.notionDeleteBlock({ blockId: firstReal })).page;
          return view;
        });
        return Promise.resolve();
      },
      indent: (block, caret) => {
        const current = pageRef.current;
        if (!current) return Promise.resolve();
        const moved = indentIn(current.blocks, block.id);
        if (!moved) return Promise.resolve();
        return relocate(current, moved.blocks, block.id, caret, { parentId: moved.parentId });
      },
      outdent: (block, caret) => {
        const current = pageRef.current;
        if (!current) return Promise.resolve();
        const moved = outdentIn(current.blocks, block.id);
        if (!moved) return Promise.resolve();
        return relocate(current, moved.blocks, block.id, caret, { afterId: moved.afterId });
      },
    };
  }, [client, editLocal, enqueue, focus, learnId, liveBlock, newLocalId, realId, requestFocus, structBusy]);

  // Notion 式文末行:最后一行是空段落就聚焦它,否则追加一个新空段落。
  const blocks = page?.blocks ?? [];
  const lastBlock = blocks[blocks.length - 1];
  // 文末已经是空段落时,它自己就是"文末行",幽灵行不再渲染——永远只有一行。
  const tailIsEmptyParagraph =
    lastBlock !== undefined &&
    lastBlock.kind === "paragraph" &&
    lastBlock.children.length === 0 &&
    lastBlock.segments.every((segment) => segment.text.trim() === "");
  const tailLine = useCallback((): void => {
    const blocks = pageRef.current?.blocks ?? [];
    const last = blocks[blocks.length - 1];
    const emptyTail =
      last !== undefined &&
      last.kind === "paragraph" &&
      last.children.length === 0 &&
      last.segments.every((segment) => segment.text.trim() === "");
    if (last && emptyTail) requestFocus(last.id, "end");
    else void editor.addBelow(null, "paragraph");
  }, [editor, requestFocus]);

  const flat = useMemo(() => flattenTree(roots ?? []), [roots]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeCollapsed(next);
      return next;
    });
  }, []);

  // —— 侧栏拖拽:把页面拖到另一个页面上 = 移到它下面(Notion 同款) ——
  // 用指针事件而不是 HTML5 拖放:桌面壳的 WebView 对后者支持不一致。
  const rootsRef = useRef<NotionTreeNodeView[] | null>(roots);
  rootsRef.current = roots;
  const [dragUi, setDragUi] = useState<{ id: string; title: string; x: number; y: number; overId: string | null } | null>(null);
  const justDragged = useRef(false);

  const movePageTo = useCallback(
    (id: string, parentId: string): void => {
      const before = rootsRef.current;
      if (!before) return;
      // 先改本地树,松手立刻见效;请求失败再还原。
      const optimistic = moveNodeIn(before, id, parentId);
      rootsRef.current = optimistic;
      setRoots(optimistic);
      setCollapsed((current) => {
        if (!current.has(parentId)) return current;
        const next = new Set(current);
        next.delete(parentId);
        writeCollapsed(next);
        return next;
      });
      void client
        .notionMovePage({ pageId: id, parentId })
        .then((result) => {
          rootsRef.current = result.roots;
          setRoots(result.roots);
          writeKnowledgeCache({ roots: result.roots });
        })
        .catch((error) => {
          rootsRef.current = before;
          setRoots(before);
          push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
        });
    },
    [client, push],
  );

  const beginTreeDrag = useCallback(
    (event: ReactPointerEvent, node: { id: string; title: string; object: string }): void => {
      if (event.button !== 0 || node.object !== "page") return;
      const startX = event.clientX;
      const startY = event.clientY;
      let active = false;
      const overOf = (x: number, y: number): string | null => {
        const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-tree-id]");
        const id = row?.dataset.treeId ?? null;
        return id && canDropPage(rootsRef.current ?? [], node.id, id) ? id : null;
      };
      const stop = (): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      };
      const onMove = (move: PointerEvent): void => {
        if (!active) {
          if (Math.hypot(move.clientX - startX, move.clientY - startY) < 6) return;
          active = true;
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
        }
        setDragUi({ id: node.id, title: node.title, x: move.clientX, y: move.clientY, overId: overOf(move.clientX, move.clientY) });
      };
      const onUp = (up: PointerEvent): void => {
        stop();
        if (!active) return;
        // 松手后浏览器还会补一个 click,别让它把页面打开了。
        justDragged.current = true;
        setTimeout(() => {
          justDragged.current = false;
        }, 50);
        const target = overOf(up.clientX, up.clientY);
        setDragUi(null);
        if (target) movePageTo(node.id, target);
      };
      const onCancel = (): void => {
        stop();
        setDragUi(null);
      };
      const onKey = (key: KeyboardEvent): void => {
        if (key.key === "Escape") onCancel();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey);
    },
    [movePageTo],
  );

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
    <div
      className="knowledge"
      style={{ "--knowledge-sidebar-w": `${sidebarWidth}px` } as CSSProperties}
    >
      <aside className="knowledge-sidebar">
        <div
          className={"knowledge-resizer" + (resizing ? " is-dragging" : "")}
          onMouseDown={startResize}
          role="separator"
          aria-orientation="vertical"
        />
        <div className="knowledge-sidebar-actions">
          <input
            className="knowledge-search"
            type="search"
            placeholder={t("knowledgeSidebarSearch")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className="knowledge-new-page"
            title={t("knowledgeNewPage")}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void client
                .notionCreatePage({ title: t("knowledgeUntitled") })
                .then(async (created) => {
                  await refreshMeta();
                  open(created.pageId);
                  setTitleDraft(created.view?.title ?? t("knowledgeUntitled"));
                  setTitleEditing(true);
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
            ＋ {t("knowledgeNewPage")}
          </button>
        </div>
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
              onOpen={(id) => {
                if (!justDragged.current) open(id);
              }}
              dragId={dragUi?.id ?? null}
              dropTargetId={dragUi?.overId ?? null}
              onDragStart={beginTreeDrag}
              untitled={t("knowledgeUntitled")}
              onCreateChild={(parentId) => {
                setBusy(true);
                void client
                  .notionCreatePage({ parentId, title: t("knowledgeUntitled") })
                  .then(async (created) => {
                    await refreshMeta();
                    open(created.pageId);
                    setTitleDraft(created.view?.title ?? t("knowledgeUntitled"));
                    setTitleEditing(true);
                  })
                  .catch((error) =>
                    push({
                      message: error instanceof Error ? error.message : String(error),
                      tone: "danger",
                    }),
                  )
                  .finally(() => setBusy(false));
              }}
              onRename={(id, current) => {
                setRenameDraft(current);
                setRename({ id, current });
              }}
              onDelete={(id) => {
                setConfirmDelete(id);
              }}
              busy={busy}
              t={t}
            />
          )}
        </nav>
        <ConfirmDialog
          open={confirmDelete !== null}
          tone="danger"
          title={t("knowledgeDelete")}
          description={t("knowledgeDeletePageConfirm")}
          confirmLabel={t("knowledgeDelete")}
          cancelLabel={t("cancel")}
          loading={busy}
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => {
            const id = confirmDelete;
            if (!id) return;
            setBusy(true);
            void client
              .notionArchivePage({ pageId: id })
              .then(async (result) => {
                setConfirmDelete(null);
                await refreshMeta();
                setRoots(result.roots);
                if (selectedId === id) {
                  const fallback = defaultPageId(result.roots);
                  if (fallback) open(fallback);
                  else navigate("/knowledge");
                }
              })
              .catch((error) =>
                push({
                  message: error instanceof Error ? error.message : String(error),
                  tone: "danger",
                }),
              )
              .finally(() => setBusy(false));
          }}
        />
        <Dialog
          open={rename !== null}
          onClose={() => setRename(null)}
          title={t("knowledgeRename")}
          initialFocus="first"
          footer={
            <>
              <Button variant="ghost" data-cancel="" onClick={() => setRename(null)}>
                {t("cancel")}
              </Button>
              <Button
                loading={busy}
                onClick={() => {
                  const target = rename;
                  const next = renameDraft.trim();
                  if (!target || next === "" || next === target.current) {
                    setRename(null);
                    return;
                  }
                  setBusy(true);
                  void client
                    .notionPatchTitle({ pageId: target.id, title: next })
                    .then(async () => {
                      setRename(null);
                      await refreshMeta();
                      if (selectedId === target.id && page) {
                        const detail = await client.notionPage(target.id);
                        commitPage(detail);
                        writeKnowledgeCache({ pageId: target.id, page: detail });
                      }
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
                {t("knowledgeSave")}
              </Button>
            </>
          }
        >
          <Input
            label={t("knowledgeRename")}
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
          />
        </Dialog>
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
            {saveState !== "idle" ? (
              <div className="knowledge-save-state" data-state={saveState} role="status">
                {saveState === "saving" ? t("knowledgeSaving") : t("knowledgeSaveFailed")}
              </div>
            ) : null}
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
                        commitPage({ ...result.page, blocks: pageRef.current?.blocks ?? result.page.blocks });
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
                    onCompositionStart={titleIme.onCompositionStart}
                    onCompositionEnd={titleIme.onCompositionEnd}
                    onKeyDown={(event) => {
                      // 输入法选词的回车不是提交。
                      if (event.key === "Enter" && titleIme.isComposing(event)) event.preventDefault();
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
            <div
              className="knowledge-blocks"
              onClick={(event) => {
                // Notion 习惯:点正文空白处,光标落到文末可编辑行。
                const target = event.target as HTMLElement;
                if (target.closest("a, button, [contenteditable], .nb-menu, .nb-code, .knowledge-properties, .knowledge-title-form")) return;
                if (target !== event.currentTarget) return;
                // 只有点在最后一行下方的空白才落到文末;行与行之间的缝隙别把光标拽走。
                const rows = event.currentTarget.querySelectorAll(".nb-row");
                const lastRow = rows[rows.length - 1];
                if (lastRow && event.clientY < lastRow.getBoundingClientRect().bottom) return;
                tailLine();
              }}
            >
              <BlockList
                blocks={page.blocks}
                t={t}
                assetBase={(blockId) => client.notionAssetUrl(blockId)}
                editor={editor}
                focus={focus === null ? null : { ...focus }}
                onFocusHandled={() => setFocus(null)}
              />
              {/* Notion 式末尾幽灵行:仅当文末不是空段落且无创建中的空段时显示,保证永远只有一行。 */}
              {!tailIsEmptyParagraph ? (
                <div
                  className="knowledge-new-line"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    tailLine();
                  }}
                >
                  <div className="knowledge-new-line-body">{t("knowledgeNewBlockHint")}</div>
                </div>
              ) : null}
            </div>
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
      {dragUi !== null ? (
        <div className="knowledge-drag-ghost" style={{ left: dragUi.x + 12, top: dragUi.y + 10 }}>
          {dragUi.title || t("knowledgeUntitled")}
        </div>
      ) : null}
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
  dragId,
  dropTargetId,
  onDragStart,
  depth = 0,
  untitled,
  onCreateChild,
  onRename,
  onDelete,
  busy,
  t,
}: {
  nodes: readonly NotionTreeNodeView[];
  selectedId: string | null;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  /** 正在被拖的页面、当前悬停的可放置目标;松手即移动。 */
  dragId: string | null;
  dropTargetId: string | null;
  onDragStart: (event: ReactPointerEvent, node: { id: string; title: string; object: string }) => void;
  depth?: number;
  untitled: string;
  onCreateChild: (parentId: string) => void;
  onRename: (id: string, current: string) => void;
  onDelete: (id: string) => void;
  busy: boolean;
  t: Translate;
}): ReactNode {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  return (
    <>
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const isCollapsed = collapsed.has(node.id);
        return (
          <div key={node.id}>
            <div
              className={
                "knowledge-tree-row" +
                (dropTargetId === node.id ? " is-drop-target" : "") +
                (dragId === node.id ? " is-dragging" : "")
              }
              data-tree-id={node.id}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              onMouseLeave={() => setMenuFor((value) => (value === node.id ? null : value))}
            >
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
                onPointerDown={(event) => onDragStart(event, node)}
              >
                <span className="knowledge-tree-title">
                  {node.icon ?? (node.object === "database" ? "🗂" : "📄")} {node.title || untitled}
                </span>
              </button>
              <button
                type="button"
                className="knowledge-tree-more"
                aria-label={t("knowledgePageMenu")}
                onClick={() => setMenuFor((value) => (value === node.id ? null : node.id))}
              >
                ⋯
              </button>
              {menuFor === node.id ? (
                <div className="nb-menu knowledge-tree-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy || node.object !== "page"}
                    onClick={() => {
                      setMenuFor(null);
                      onCreateChild(node.id);
                    }}
                  >
                    ＋ {t("knowledgeNewSubpage")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    onClick={() => {
                      setMenuFor(null);
                      onRename(node.id, node.title);
                    }}
                  >
                    ✎ {t("knowledgeRename")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="is-danger"
                    disabled={busy}
                    onClick={() => {
                      setMenuFor(null);
                      onDelete(node.id);
                    }}
                  >
                    🗑 {t("knowledgeDelete")}
                  </button>
                </div>
              ) : null}
            </div>
            {hasChildren && !isCollapsed ? (
              <TreeNodes
                nodes={node.children}
                selectedId={selectedId}
                collapsed={collapsed}
                onToggle={onToggle}
                onOpen={onOpen}
                dragId={dragId}
                dropTargetId={dropTargetId}
                onDragStart={onDragStart}
                depth={depth + 1}
                untitled={untitled}
                onCreateChild={onCreateChild}
                onRename={onRename}
                onDelete={onDelete}
                busy={busy}
                t={t}
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

/** 焦点是否正在知识库正文的可编辑行里。 */
function isEditingBlocks(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.isContentEditable && active.closest(".knowledge-blocks") !== null;
}

function findNode(nodes: readonly NotionTreeNodeView[], id: string): NotionTreeNodeView | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findNode(node.children, id);
    if (nested) return nested;
  }
  return null;
}
