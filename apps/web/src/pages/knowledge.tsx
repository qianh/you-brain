import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";

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
import { openLocalPath } from "../lib/local-path.js";
import { useImeGuard } from "../lib/ime-guard.js";
import { settingsHref } from "../lib/route.js";
import { browserWindowBridge } from "../lib/window.js";
import { useRoute } from "../router.js";
import { BlockList, isFoldable, OpenStateContext } from "./knowledge/blocks-view.js";
import { createFocusStore } from "./knowledge/focus-store.js";
import { EmojiPicker } from "./knowledge/block-media.js";
import { DatabaseView, PropertyCell } from "./knowledge/database-view.js";
import { useBlockInteractions } from "./knowledge/block-interactions.js";
import { caretOffsetIn, setCaretAtOffset } from "./knowledge/dom-text.js";
import { COMMIT_EVENT, type BlockEditorCallbacks, type FocusRequest, type SpecialKind, type Translate } from "./knowledge/block-editor.js";
import {
  LOCAL_ID_PREFIX,
  convertBlock,
  defaultPageId,
  findBlockIn,
  flattenTree,
  fuzzyFilter,
  hasSegments,
  indentIn,
  isLocalId,
  outdentIn,
  pairBlockIds,
  pastedToLocal,
  plainSegments,
  canDropPage,
  moveNodeIn,
  applyTableOp,
  makeLocalBlock,
  relativeTime,
  remapBlockIds,
  removeBlockIn,
  segmentsText,
  updateBlockIn,
  withSegments,
  type FlatPage,
  type TurnIntoKind,
  acceptsChildren,
  blocksToMarkdownText,
  canColorBlock,
  canMoveBlock,
  insertAtPlacement,
  isLocalPending,
  jsonEqual,
  placementOf,
  topmostSelected,
  type BlockPlacement,
  type TableOp,
} from "./knowledge/logic.js";

interface KnowledgeCache {
  roots: NotionTreeNodeView[] | null;
  status: NotionStatusView | null;
  pageId: string | null;
  page: NotionPageView | null;
}

const CACHE_KEY = "you-brain:knowledge:v1";

function loadKnowledgeCache(): KnowledgeCache {
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

/** 内存里的最新缓存;写 localStorage 要序列化整页,所以只在空闲或离页时落盘。 */
let memoryCache: KnowledgeCache | null = null;
let cacheDirty = false;
let cacheFlushTimer: ReturnType<typeof setTimeout> | null = null;

function readKnowledgeCache(): KnowledgeCache {
  memoryCache ??= loadKnowledgeCache();
  return memoryCache;
}

function flushKnowledgeCache(): void {
  if (cacheFlushTimer) clearTimeout(cacheFlushTimer);
  cacheFlushTimer = null;
  if (!cacheDirty || !memoryCache) return;
  cacheDirty = false;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(memoryCache));
  } catch {
    // 隐私模式等写不进就算了,只影响下次的秒开。
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushKnowledgeCache);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushKnowledgeCache();
  });
}

function writeKnowledgeCache(patch: Partial<KnowledgeCache>): void {
  // 整体替换成新对象:已经拿到旧快照的调用方(如挂载时读的缓存)不受影响。
  memoryCache = { ...readKnowledgeCache(), ...patch };
  cacheDirty = true;
  if (cacheFlushTimer) return;
  cacheFlushTimer = setTimeout(flushKnowledgeCache, 1000);
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

const OPEN_TOGGLES_KEY = "you-brain:knowledge:open-toggles:v1";

/** 展开过的折叠块(Notion 记住每个折叠块的开合)。 */
function readOpenToggles(): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OPEN_TOGGLES_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(-2000) : []);
  } catch {
    return new Set();
  }
}

function writeOpenToggles(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(OPEN_TOGGLES_KEY, JSON.stringify([...ids].slice(-2000)));
  } catch {
    // 写不进就只在本次会话内有效。
  }
}

/** 一步编辑的撤销与重做。 */
interface HistoryStep {
  undo(): void;
  redo(): void;
}

const MEDIA_KINDS = new Set(["image", "video", "audio", "file", "pdf"]);

function writeCollapsed(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    // 写不进就只在本次会话内有效。
  }
}

export function KnowledgePage() {
  const { client, t, language, notionRevision } = useDaemon();
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
  /** 每页在本机的最新视图(含还没写回 Notion 的编辑):切回来直接用它,秒开且不会读到旧内容。 */
  const pageMemo = useRef(new Map<string, NotionPageView>());
  /** 每页还没写完的保存数;有在途保存的页面以本地为准,不用索引覆盖。 */
  const pendingByPage = useRef(new Map<string, number>());
  const commitPage = useCallback((next: NotionPageView | null): void => {
    pageRef.current = next;
    if (next) pageMemo.current.set(next.id, next);
    setPage(next);
  }, []);
  // 同步完成等场景要求「当前页按索引重读一次」。
  const [reloadTick, setReloadTick] = useState(0);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");
  // 「保存中」只在挂起超过 1.5 秒才显示,正常打字时不闪;失败立即显示。
  const [savingVisible, setSavingVisible] = useState(false);
  useEffect(() => {
    if (saveState !== "saving") {
      setSavingVisible(false);
      return;
    }
    const timer = setTimeout(() => setSavingVisible(true), 1500);
    return () => clearTimeout(timer);
  }, [saveState]);
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
  // 页面标题:边输入边保存(Notion 同款),点外面/切页也保存,Esc 撤回本次修改。
  const titleInput = useRef<HTMLInputElement>(null);
  const titleDraftRef = useRef("");
  /** 正在编辑哪一页的标题,以及开始编辑时的原标题(Esc 撤回用)。 */
  const titleTarget = useRef<{ pageId: string; origin: string } | null>(null);
  /** 每页最后一次写回(或正在写回)的标题,避免重复请求。 */
  const titleSent = useRef(new Map<string, string>());
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleQueue = useRef<Promise<void>>(Promise.resolve());
  /** 还没落地的标题保存数。 */
  const titleInFlight = useRef(0);
  const endTitleEditRef = useRef<(mode: "save" | "revert") => void>(() => undefined);
  const focusTitleRef = useRef<() => void>(() => undefined);
  const [busy, setBusy] = useState(false);
  // 焦点请求走按块订阅的 store:回车、移动光标只重渲染目标行。
  const focusStore = useMemo(() => createFocusStore(), []);
  // Tauri 的 WKWebView 不支持 window.confirm/prompt,确认与改名走 Dialog。
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [rename, setRename] = useState<{ id: string; current: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const raw = Number(localStorage.getItem("knowledge-sidebar-w"));
    return Number.isFinite(raw) && raw >= 200 && raw <= 520 ? raw : 264;
  });
  const [resizing, setResizing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // 正文版心:默认居中约 720px(易读),可切全宽;只是本机的显示偏好。
  const [wide, setWide] = useState(() => {
    try {
      return localStorage.getItem("knowledge-wide") === "1";
    } catch {
      return false;
    }
  });
  const toggleWide = (): void => {
    setWide((value) => {
      try {
        localStorage.setItem("knowledge-wide", value ? "0" : "1");
      } catch {
        // 写不进只影响下次的显示偏好。
      }
      return !value;
    });
  };
  const startResize = (event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const clamp = (value: number): number => Math.min(520, Math.max(200, value));
    // 拖动中只改 CSS 变量,不 setState,正文区不跟着重渲染;松手才落 state 和 localStorage。
    const onMove = (move: MouseEvent): void => {
      rootRef.current?.style.setProperty("--knowledge-sidebar-w", `${clamp(startWidth + move.clientX - startX)}px`);
    };
    const onUp = (move: MouseEvent): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const finalWidth = clamp(startWidth + move.clientX - startX);
      setSidebarWidth(finalWidth);
      setResizing(false);
      try {
        localStorage.setItem("knowledge-sidebar-w", String(finalWidth));
      } catch {
        // 写不进只影响下次的宽度。
      }
    };
    setResizing(true);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const selectedId = location.id;
  /** 工作区成员(@ 提及候选),进入知识库时取一次。 */
  const usersRef = useRef<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    void client
      .notionUsers()
      .then((result) => {
        usersRef.current = result.users;
      })
      .catch(() => undefined);
  }, [client]);
  /** 编辑回调里读最新目录(@ 提及的候选页面)。 */
  const treeRef = useRef<NotionTreeNodeView[] | null>(roots);
  treeRef.current = roots;
  const selectedKind = useMemo(
    () => (selectedId ? (findNode(roots ?? [], selectedId)?.object ?? null) : null),
    [roots, selectedId],
  );

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

  // daemon 后台同步出了变化(Notion 那边改过):刷新目录;当前页等没有在途保存、没有在编辑时再重读,不打断输入。
  const syncStale = useRef(false);
  const seenNotionRevision = useRef(notionRevision);
  useEffect(() => {
    if (seenNotionRevision.current === notionRevision) return;
    seenNotionRevision.current = notionRevision;
    syncStale.current = true;
    void refreshMeta().catch(() => undefined);
  }, [notionRevision, refreshMeta]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!syncStale.current) return;
      if (pendingJobs.current > 0 || titleInFlight.current > 0 || titleTarget.current || isEditingBlocks()) return;
      syncStale.current = false;
      setReloadTick((value) => value + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // 标题编辑框:点外面就保存并收起(有的区域按下时会阻止失焦,不能只靠 blur)。
  useEffect(() => {
    if (!titleEditing) return;
    const onDown = (event: MouseEvent): void => {
      const form = document.querySelector(".knowledge-title-form");
      if (form && !form.contains(event.target as Node)) endTitleEditRef.current("save");
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
    // 秒开:内存里有这一页(本次会话打开过)就直接渲染;否则用上次退出时的缓存。
    const memo = pageMemo.current.get(selectedId);
    const cachedPage = cached.current.pageId === selectedId ? cached.current.page : null;
    if (selectedKind !== "database" && pageRef.current?.id !== selectedId && (memo ?? cachedPage)) {
      setDatabase(null);
      commitPage(memo ?? cachedPage);
    }
    // 这一页还有保存在路上:本地就是最新的,等保存队列收尾时再与 Notion 对齐,不用等它。
    if (selectedKind !== "database" && (pendingByPage.current.get(selectedId) ?? 0) > 0 && pageRef.current?.id === selectedId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        if (selectedKind === "database") {
          const db = await client.notionDatabase(selectedId);
          if (!alive) return;
          setDatabase(db);
          commitPage(null);
          writeKnowledgeCache({ pageId: selectedId, page: null });
        } else {
          // 读的是本机索引(几毫秒),不访问 Notion。
          const detail = await client.notionPage(selectedId);
          if (!alive) return;
          setDatabase(null);
          writeKnowledgeCache({ pageId: selectedId, page: detail });
          // 正在这一页里打字或还有保存在路上时不整页替换,否则光标会被打断、内容会倒退。
          if (
            pageRef.current?.id === selectedId &&
            ((pendingByPage.current.get(selectedId) ?? 0) > 0 || isEditingBlocks())
          ) {
            return;
          }
          sentText.current.clear();
          // 标题还有保存在路上时,本地标题比索引新(保存后刷新目录也会走到这里)。
          const local = pageRef.current;
          const keepTitle = local?.id === selectedId && titleInFlight.current > 0;
          // 沿用本地 id:内容没变时各行不重挂载,也就没有闪动。
          const next = {
            ...detail,
            title: keepTitle && local ? local.title : detail.title,
            blocks: remapBlockIds(detail.blocks, realToLocal.current),
          };
          if (local?.id === selectedId && jsonEqual(local, next)) return;
          commitPage(next);
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
    // 只在换页、页面类型确定或要求重读时加载;目录刷新(如保存标题后)不再整页重读。
  }, [client, selectedId, selectedKind, reloadTick]);

  const open = useCallback(
    (id: string) => {
      navigate(`/knowledge?id=${encodeURIComponent(id)}`);
    },
    [navigate],
  );

  // 进入知识库没带页面 id 时(顶栏切回来、重启应用):优先回到上次看的页面,
  // 它已不在目录里才退回第一篇。
  useEffect(() => {
    if (selectedId || roots === null || roots.length === 0) return;
    const last = cached.current.pageId;
    const target = last && findNode(roots, last) ? last : defaultPageId(roots);
    if (target) navigate(`/knowledge?id=${encodeURIComponent(target)}`, "replace");
  }, [navigate, roots, selectedId]);

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
      setReloadTick((value) => value + 1);
    } catch (error) {
      push({
        message: t("knowledgeSyncFailed", { error: error instanceof Error ? error.message : String(error) }),
        tone: "danger",
      });
    } finally {
      setSyncing(false);
    }
  }, [client, push, refreshMeta, t]);

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
  /** 已入队但还没开始执行的文字保存(按块 id)。 */
  const textQueued = useRef(new Set<string>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pendingJobs = useRef(0);
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
  const requestFocus = useCallback(
    (blockId: string, at: FocusRequest["at"]): void => {
      focusStore.request({ blockId, at });
    },
    [focusStore],
  );

  const enqueue = useCallback(
    (
      pageId: string,
      job: () => Promise<NotionPageView | null>,
      options?: { structural?: boolean },
    ): void => {
      pendingJobs.current += 1;
      pendingByPage.current.set(pageId, (pendingByPage.current.get(pageId) ?? 0) + 1);
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
          const left = (pendingByPage.current.get(pageId) ?? 1) - 1;
          if (left > 0) pendingByPage.current.set(pageId, left);
          else pendingByPage.current.delete(pageId);
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
              // 标题有自己的保存队列,这里的视图可能带着旧标题,不能拿它覆盖本地。
              const title = pageRef.current?.id === pageId ? pageRef.current.title : view.title;
              commitPage({ ...view, title, blocks: remapBlockIds(view.blocks, realToLocal.current) });
              writeKnowledgeCache({ pageId, page: view });
            } else if (selectedRef.current !== pageId) {
              // 已经离开这一页:丢掉内存里的本地版本,下次打开按索引重读。
              pageMemo.current.delete(pageId);
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

  // —— 折叠块的展开状态(Notion:折叠块默认收起;刚新建的默认展开)——
  const [openToggles, setOpenToggles] = useState<ReadonlySet<string>>(readOpenToggles);
  const openRef = useRef(openToggles);
  const toggleSession = useRef(new Map<string, boolean>());
  openRef.current = openToggles;

  // —— 多选(Esc、拖选、Shift+点手柄):选中的块 id,直接画在 DOM 上,不触发重渲染 ——
  const selection = useRef(new Set<string>());
  const paintSelection = useCallback((): void => {
    for (const row of document.querySelectorAll<HTMLElement>(".knowledge-blocks [data-block-id]")) {
      if (selection.current.has(row.dataset.blockId ?? "")) row.dataset.selected = "true";
      else delete row.dataset.selected;
    }
  }, []);
  const setSelection = useCallback(
    (ids: Iterable<string>): void => {
      selection.current = new Set(ids);
      paintSelection();
    },
    [paintSelection],
  );

  // —— 撤销/重做:每个编辑动作记一步,含反向操作;换页清空 ——
  const history = useRef<{ past: HistoryStep[]; future: HistoryStep[] }>({ past: [], future: [] });
  const record = useCallback((step: HistoryStep): void => {
    history.current.past.push(step);
    if (history.current.past.length > 200) history.current.past.shift();
    history.current.future = [];
  }, []);
  useEffect(() => {
    history.current = { past: [], future: [] };
    selection.current = new Set();
  }, [selectedId]);

  const editor: BlockEditorCallbacks = useMemo(() => {
    const blocksNow = (): NotionBlockModel[] => pageRef.current?.blocks ?? [];
    const live = (id: string): NotionBlockModel | null => findBlockIn(blocksNow(), id);
    /** 本地位置 → 接口的目标位置(执行时再解析真实 id);解析不了返回 null。 */
    const serverPlacement = (
      placement: BlockPlacement,
    ): { afterBlockId: string } | { parentBlockId: string; atStart: boolean } | { atStart: boolean } | null => {
      const parentReal = placement.parentId ? realId(placement.parentId) : null;
      if (placement.parentId && !parentReal) return null;
      const parentEnd = parentReal ? { parentBlockId: parentReal, atStart: false } : { atStart: false };
      // 队列串行:执行到这里还没有真实 id 的兄弟块只能是还没确定内容的占位块(图片未选文件等),
      // 跳过它们,往前找最近一个已写进 Notion 的兄弟。
      if (placement.afterId) {
        const blocks = blocksNow();
        const siblings = placement.parentId === null ? blocks : (findBlockIn(blocks, placement.parentId)?.children ?? []);
        const index = siblings.findIndex((entry) => entry.id === placement.afterId);
        if (index < 0) {
          // 锚点已经不在本地树里(比如保存失败后整页按 Notion 重载过):宁可放到末尾,也不能跑到最前面。
          const real = realId(placement.afterId);
          return real ? { afterBlockId: real } : parentEnd;
        }
        for (const candidate of siblings.slice(0, index + 1).reverse()) {
          const real = realId(candidate.id);
          if (real) return { afterBlockId: real };
        }
      }
      return parentReal ? { parentBlockId: parentReal, atStart: true } : { atStart: true };
    };
    const asInput = (model: NotionBlockModel): Record<string, unknown> => model as unknown as Record<string, unknown>;
    /** 块和它原有的子树结构,文本等内容取最新的(执行时才读)。后来加的子块有自己的新建任务,不能带上。 */
    const refresh = (model: NotionBlockModel): NotionBlockModel =>
      ({ ...(live(model.id) ?? model), children: model.children.map(refresh) }) as NotionBlockModel;
    /** 新建/复制后:登记真实 id;媒体块换成 Notion 返回的文件地址。 */
    const adopt = (local: readonly NotionBlockModel[], created: readonly NotionBlockModel[], known?: Array<[string, string]>): void => {
      const pairs = known ?? pairBlockIds(local, created);
      for (const [localId, serverId] of pairs) learnId(localId, serverId);
      const media = new Map<string, NotionBlockModel>();
      const collect = (list: readonly NotionBlockModel[]): void => {
        for (const model of list) {
          if (MEDIA_KINDS.has(model.kind)) media.set(model.id, model);
          collect(model.children);
        }
      };
      collect(created);
      if (media.size === 0) return;
      const byLocal = new Map(pairs.map(([localId, serverId]) => [localId, media.get(serverId)]));
      editLocal((blocks) => {
        let next = blocks;
        for (const [localId, server] of byLocal) {
          if (server) next = updateBlockIn(next, localId, (entry) => ({ ...server, id: entry.id, children: entry.children }) as NotionBlockModel);
        }
        return next;
      });
    };

    // —— 基本操作(不记历史;撤销/重做也调用它们)——
    const doSet = (id: string, model: NotionBlockModel): void => {
      const before = editLocal((blocks) =>
        updateBlockIn(blocks, id, (entry) => ({ ...model, id, children: entry.children }) as NotionBlockModel),
      );
      if (!before) return;
      enqueue(before.id, async () => {
        const real = realId(id);
        const now = live(id);
        if (!real || !now) return null;
        if (hasSegments(now)) sentText.current.set(id, JSON.stringify(now.segments));
        return (await client.notionPatchBlock({ blockId: real, model: asInput({ ...now, children: [] }) })).page;
      });
    };
    const doRemove = (ids: readonly string[], focusId?: string | null): void => {
      const before = editLocal((blocks) => ids.reduce((acc, id) => removeBlockIn(acc, id), blocks));
      if (!before) return;
      if (focusId) requestFocus(focusId, "end");
      enqueue(before.id, async () => {
        let view: NotionPageView | null = null;
        for (const id of ids) {
          const real = realId(id);
          if (real) view = (await client.notionDeleteBlock({ blockId: real })).page;
        }
        return view;
      });
    };
    const doRestore = (items: ReadonlyArray<{ model: NotionBlockModel; placement: BlockPlacement }>): void => {
      const before = editLocal((blocks) => items.reduce((acc, item) => insertAtPlacement(acc, item.placement, [item.model]), blocks));
      if (!before) return;
      enqueue(before.id, async () => {
        let view: NotionPageView | null = null;
        for (const item of items) {
          const target = serverPlacement(item.placement) ?? { atStart: true as const };
          const real = realId(item.model.id);
          if (real) {
            const result = await client.notionRestoreBlocks({ blockIds: [real], pageId: before.id, ...target });
            // 恢复后若被移回原位置,块换了新 id:按对应关系重新登记。
            for (const [from, to] of result.idMap ?? []) learnId(realToLocal.current.get(from) ?? from, to);
            view = result.page;
          } else {
            const model = refresh(item.model);
            const result = await client.notionCreateBlocks({ pageId: before.id, models: [asInput(model)], ...target });
            adopt([model], result.created);
            view = result.page;
          }
        }
        return view;
      });
    };
    /** 把一组块(带子树)移到 target;root 覆盖第一个块的内容(转类型)。target.afterId 等于自己 = 原地。 */
    const doRelocate = (ids: readonly string[], target: BlockPlacement, root?: NotionBlockModel): void => {
      const current = pageRef.current;
      if (!current || ids.length === 0) return;
      const inPlace = ids.length === 1 && target.afterId === ids[0];
      const withRoot = (model: NotionBlockModel): NotionBlockModel =>
        root ? ({ ...root, id: model.id, children: model.children } as NotionBlockModel) : model;
      let next: NotionBlockModel[];
      if (inPlace) {
        next = updateBlockIn(current.blocks, ids[0]!, withRoot);
      } else {
        const moved = ids.map((id) => findBlockIn(current.blocks, id)).filter((model): model is NotionBlockModel => model !== null);
        if (moved.length !== ids.length) return;
        const rest = ids.reduce((acc, id) => removeBlockIn(acc, id), current.blocks);
        next = insertAtPlacement(rest, target, moved.map((model, index) => (index === 0 ? withRoot(model) : model)));
      }
      commitPage({ ...current, blocks: next });
      enqueue(current.id, async () => {
        const reals = ids.map((id) => realId(id));
        if (reals.some((real) => !real)) return null;
        const dest = inPlace ? { afterBlockId: reals[0]! } : serverPlacement(target);
        if (!dest) return null;
        const models = ids.map((id) => live(id)).filter((model): model is NotionBlockModel => model !== null);
        const result = await client.notionRelocateBlocks({
          blockIds: reals as string[],
          mode: "move",
          ...dest,
          ...(root && models[0] ? { root: asInput({ ...models[0], children: [] }) } : {}),
        });
        // 按服务端给的「原 id → 新 id」登记(本地树里可能已有还没写进 Notion 的新子块,不能按位置对)。
        adopt(models, result.created, (result.idMap ?? []).map(([from, to]) => [realToLocal.current.get(from) ?? from, to]));
        for (const id of ids) sentText.current.delete(id);
        return result.page;
      });
    };
    /** 新建一组块(带子树,任意类型)。 */
    const doInsert = (models: readonly NotionBlockModel[], placement: BlockPlacement): void => {
      const before = editLocal((blocks) => insertAtPlacement(blocks, placement, models));
      if (!before) return;
      enqueue(before.id, async () => {
        let anchor = serverPlacement(placement);
        if (!anchor) return null;
        let view: NotionPageView | null = null;
        // 单次最多 100 个顶层块;每批接在上一批最后一个后面。
        for (let start = 0; start < models.length; start += 100) {
          const batch = models.slice(start, start + 100).map(refresh);
          const result = await client.notionCreateBlocks({ pageId: before.id, models: batch.map(asInput), ...anchor });
          adopt(batch, result.created);
          view = result.page;
          const last = result.created[result.created.length - 1];
          if (!last) break;
          anchor = { afterBlockId: last.id };
        }
        return view;
      });
    };
    /** 复制一个块(带子树):本地先放副本,Notion 端重建(托管文件会重新上传)。cloneOf:原块本地 id → 副本本地 id。 */
    const doCopy = (id: string, clone: NotionBlockModel, cloneOf: ReadonlyMap<string, string>): void => {
      const before = editLocal((blocks) => insertAtPlacement(blocks, { parentId: placementOf(blocks, id)?.parentId ?? null, afterId: id }, [clone]));
      if (!before) return;
      enqueue(before.id, async () => {
        const real = realId(id);
        if (!real) return null;
        const result = await client.notionRelocateBlocks({ blockIds: [real], mode: "copy", afterBlockId: real });
        const pairs = (result.idMap ?? []).flatMap(([from, to]): Array<[string, string]> => {
          const copy = cloneOf.get(realToLocal.current.get(from) ?? from);
          return copy ? [[copy, to]] : [];
        });
        adopt([live(clone.id) ?? clone], result.created, pairs);
        return result.page;
      });
    };
    const applyTable = (blockId: string, op: TableOp): void => {
      const before = editLocal((blocks) =>
        updateBlockIn(blocks, blockId, (entry) => (entry.kind === "table" ? applyTableOp(entry, op) : entry)),
      );
      if (!before) return;
      enqueue(before.id, async () => {
        const tableId = realId(blockId);
        if (!tableId) return null;
        const result = await client.notionTableEdit({ ...op, tableId });
        if (op.op === "rebuild") {
          // 整表重建后表格换了 id:把新 id 登记给原来的本地 id,后续编辑照常定位。
          const known = new Set<string>();
          const collect = (list: readonly NotionBlockModel[]): void => {
            for (const entry of list) {
              known.add(realId(entry.id) ?? entry.id);
              collect(entry.children);
            }
          };
          collect(blocksNow());
          const find = (list: readonly NotionBlockModel[]): NotionBlockModel | null => {
            for (const entry of list) {
              if (entry.kind === "table" && !known.has(entry.id)) return entry;
              const nested = find(entry.children);
              if (nested) return nested;
            }
            return null;
          };
          const rebuilt = find(result.page.blocks);
          if (rebuilt) learnId(blockId, rebuilt.id);
        }
        return result.page;
      });
    };

    // —— 带历史的组合操作 ——
    /** 改一个块的内容/属性,记一步(撤销回到改之前)。 */
    const setWithHistory = (id: string, next: NotionBlockModel): void => {
      const prev = live(id);
      if (!prev) return;
      doSet(id, next);
      record({ undo: () => doSet(id, prev), redo: () => doSet(id, next) });
    };
    /** 删除一组块,记一步(撤销恢复到原位置,块 id 不变)。 */
    const removeWithHistory = (ids: readonly string[], focusId?: string | null): void => {
      const blocks = blocksNow();
      const top = topmostSelected(blocks, new Set(ids));
      const items = top
        .map((id) => ({ model: findBlockIn(blocks, id), placement: placementOf(blocks, id) }))
        .filter((item): item is { model: NotionBlockModel; placement: BlockPlacement } => item.model !== null && item.placement !== null);
      if (items.length === 0) return;
      doRemove(top, focusId);
      record({ undo: () => doRestore(items), redo: () => doRemove(top) });
    };
    /** 新建块,记一步(撤销删掉,重做恢复)。 */
    const insertWithHistory = (models: NotionBlockModel[], placement: BlockPlacement): void => {
      doInsert(models, placement);
      const ids = models.map((model) => model.id);
      let snapshot: Array<{ model: NotionBlockModel; placement: BlockPlacement }> = [];
      record({
        undo: () => {
          const blocks = blocksNow();
          snapshot = ids
            .map((id) => ({ model: findBlockIn(blocks, id), placement: placementOf(blocks, id) }))
            .filter((item): item is { model: NotionBlockModel; placement: BlockPlacement } => item.model !== null && item.placement !== null);
          doRemove(ids);
        },
        redo: () => doRestore(snapshot),
      });
    };
    /** 移动一组块,记一步(撤销逐个移回原位置、恢复原内容)。 */
    const relocateWithHistory = (ids: readonly string[], target: BlockPlacement, root?: NotionBlockModel): void => {
      const blocks = blocksNow();
      const origins = ids.map((id) => ({ id, placement: placementOf(blocks, id), model: findBlockIn(blocks, id) }));
      if (origins.some((origin) => !origin.placement || !origin.model)) return;
      doRelocate(ids, target, root);
      const rootChanged = root !== undefined;
      record({
        undo: () => {
          for (const origin of origins) {
            const back = origin.placement!;
            // 原地转类型:原地换回原来的类型。
            const inPlace = ids.length === 1 && target.afterId === ids[0];
            doRelocate([origin.id], inPlace ? { parentId: back.parentId, afterId: origin.id } : back, rootChanged && origin.id === ids[0] ? origin.model! : undefined);
          }
        },
        redo: () => doRelocate(ids, target, root),
      });
    };
    const compose = (steps: HistoryStep[]): HistoryStep => ({
      undo: () => [...steps].reverse().forEach((step) => step.undo()),
      redo: () => steps.forEach((step) => step.redo()),
    });
    const syncText = (pageId: string, blockId: string): void => {
      // 这一块已有还没开始发的文字保存:它执行时读的是最新文字,不用再排一次(同一块连续修改合并成一次请求)。
      if (textQueued.current.has(blockId)) return;
      textQueued.current.add(blockId);
      enqueue(pageId, async () => {
        textQueued.current.delete(blockId);
        const real = realId(blockId);
        const now = live(blockId);
        if (!real || !now || !hasSegments(now)) return null;
        const json = JSON.stringify(now.segments);
        if (sentText.current.get(blockId) === json) return null;
        sentText.current.set(blockId, json);
        const result = await client.notionUpdateBlock({ blockId: real, markdown: "", rich: now.segments });
        return result.page;
      });
    };
    /** 当前块之后(同一层)的位置。 */
    const after = (id: string): BlockPlacement => ({ parentId: placementOf(blocksNow(), id)?.parentId ?? null, afterId: id });
    const emptyParagraph = (): NotionBlockModel => makeLocalBlock(newLocalId(), "paragraph");
    const textModel = (segments: NotionSegment[]): NotionBlockModel => makeLocalBlock(newLocalId(), "paragraph", segments);
    /** 在 block 之后放新块;replace 时顺带删掉 block(空段落被替换),整体记一步。 */
    const placeNew = (block: NotionBlockModel, models: NotionBlockModel[], replace: boolean, persist: boolean): void => {
      const placement = after(block.id);
      if (persist) {
        doInsert(models, placement);
      } else {
        editLocal((blocks) => insertAtPlacement(blocks, placement, models));
      }
      const steps: HistoryStep[] = [];
      if (persist) {
        const ids = models.map((model) => model.id);
        let snapshot: Array<{ model: NotionBlockModel; placement: BlockPlacement }> = [];
        steps.push({
          undo: () => {
            const blocks = blocksNow();
            snapshot = ids
              .map((id) => ({ model: findBlockIn(blocks, id), placement: placementOf(blocks, id) }))
              .filter((item): item is { model: NotionBlockModel; placement: BlockPlacement } => item.model !== null && item.placement !== null);
            doRemove(ids);
          },
          redo: () => doRestore(snapshot),
        });
      }
      if (replace) {
        const original = live(block.id);
        const origin = placementOf(blocksNow(), block.id);
        doRemove([block.id]);
        if (original && origin) steps.push({ undo: () => doRestore([{ model: original, placement: origin }]), redo: () => doRemove([block.id]) });
      }
      if (steps.length > 0) record(compose(steps));
    };
    const cloneWithIds = (model: NotionBlockModel, map: Map<string, string>): NotionBlockModel => {
      const id = newLocalId();
      map.set(model.id, id);
      return { ...model, id, children: model.children.map((child) => cloneWithIds(child, map)) } as NotionBlockModel;
    };
    const uploadFile = async (file: File): Promise<string> => {
      if (file.size > 20 * 1024 * 1024) throw new Error(t("knowledgeMediaUploadLimit"));
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/u, ""));
        reader.onerror = () => reject(reader.error ?? new Error("read failed"));
        reader.readAsDataURL(file);
      });
      const result = await client.notionUploadFile({ filename: file.name || "file", contentType: file.type || "application/octet-stream", dataBase64 });
      return result.uploadId;
    };
    const fileKind = (file: File): "image" | "video" | "audio" | "pdf" | "file" =>
      file.type.startsWith("image/")
        ? "image"
        : file.type.startsWith("video/")
          ? "video"
          : file.type.startsWith("audio/")
            ? "audio"
            : file.type === "application/pdf"
              ? "pdf"
              : "file";
    // 本次会话里点过的以点过的为准(本地新建的折叠块默认展开,之后才拿到真实 id);其余按记住的展开状态。
    const isOpen = (id: string): boolean =>
      toggleSession.current.get(id) ?? (isLocalId(id) || openRef.current.has(realId(id) ?? id));
    const setOpen = (id: string, open: boolean): void => {
      toggleSession.current.set(id, open);
      const key = realId(id) ?? id;
      setOpenToggles((current) => {
        // 本地状态变了也要重渲染:换一个新 Set。
        const next = new Set(current);
        if (open) next.add(key);
        else next.delete(key);
        writeOpenToggles(next);
        return next;
      });
    };
    const convert = (block: NotionBlockModel, kind: TurnIntoKind): void => {
      const now = live(block.id) ?? block;
      const next = convertBlock(now, kind);
      if (kind === "code") requestFocus(block.id, "start");
      // 转成不能带子块的类型(普通标题、代码):子块先挪到它后面,和 Notion 一样不丢内容。
      if (now.children.length > 0 && !acceptsChildren(next)) {
        const childIds = now.children.map((child) => child.id);
        const blocks = blocksNow();
        const origin = placementOf(blocks, block.id);
        const childOrigins = childIds.map((id) => ({ id, placement: placementOf(blocks, id) }));
        doRelocate(childIds, { parentId: origin?.parentId ?? null, afterId: block.id });
        doRelocate([block.id], { parentId: origin?.parentId ?? null, afterId: block.id }, { ...next, children: [] } as NotionBlockModel);
        record({
          undo: () => {
            doRelocate([block.id], { parentId: origin?.parentId ?? null, afterId: block.id }, now);
            for (const child of childOrigins) if (child.placement) doRelocate([child.id], child.placement);
          },
          redo: () => {
            doRelocate(childIds, { parentId: origin?.parentId ?? null, afterId: block.id });
            doRelocate([block.id], { parentId: origin?.parentId ?? null, afterId: block.id }, next);
          },
        });
        return;
      }
      relocateWithHistory([block.id], { parentId: placementOf(blocksNow(), block.id)?.parentId ?? null, afterId: block.id }, next);
    };
    const special = (block: NotionBlockModel, kind: SpecialKind, replace: boolean): void => {
      const id = newLocalId();
      const pending = (model: NotionBlockModel): void => placeNew(block, [model], replace, false);
      switch (kind) {
        case "image":
        case "video":
        case "audio":
          pending({ id, children: [], kind, url: "", caption: [] });
          return;
        case "file":
        case "pdf":
          pending({ id, children: [], kind, url: "", name: "", caption: [] });
          return;
        case "bookmark":
          pending({ id, children: [], kind: "bookmark", url: "", caption: [] });
          return;
        case "embed":
          pending({ id, children: [], kind: "embed", url: "", caption: [] });
          return;
        case "equation":
          pending({ id, children: [], kind: "equation", expression: "" });
          return;
        case "linkToPage":
          pending({ id, children: [], kind: "link_to_page", targetId: null, targetKind: "page" });
          return;
        case "toc":
          placeNew(block, [{ id, children: [], kind: "table_of_contents" }], replace, true);
          return;
        case "breadcrumb":
          placeNew(block, [{ id, children: [], kind: "breadcrumb" }], replace, true);
          return;
        case "table": {
          const empty = (): NotionSegment[][] => [[], [], []];
          placeNew(block, [{ id, children: [], kind: "table", hasHeader: true, hasRowHeader: false, rows: [empty(), empty(), empty()] }], replace, true);
          return;
        }
        case "columns2":
        case "columns3":
        case "columns4": {
          const count = Number(kind.slice(-1));
          const columns = Array.from({ length: count }, (): NotionBlockModel => ({ id: newLocalId(), kind: "column", widthRatio: null, children: [emptyParagraph()] }));
          placeNew(block, [{ id, kind: "column_list", children: columns }], replace, true);
          const first = columns[0]?.children[0];
          if (first) requestFocus(first.id, "start");
          return;
        }
        case "tabs": {
          const tab = (label: string): NotionBlockModel => ({ ...textModel(plainSegments(label)), children: [emptyParagraph()] });
          placeNew(block, [{ id, kind: "tab", children: [tab(`${t("knowledgeTypeTabs")} 1`), tab(`${t("knowledgeTypeTabs")} 2`)] }], replace, true);
          return;
        }
        case "databaseInline":
        case "databasePage": {
          const current = pageRef.current;
          if (!current) return;
          if (replace) removeWithHistory([block.id]);
          const inline = kind === "databaseInline";
          // 等前面的保存写完再建(Notion 把数据库放在页面末尾)。
          enqueue(current.id, async () => {
            const result = await client.notionCreateDatabase({ pageId: current.id, title: t("knowledgeNewDatabaseTitle"), inline });
            editLocal((blocks) => [...blocks, { id: result.databaseId, children: [], kind: "child_database", title: t("knowledgeNewDatabaseTitle"), databaseId: result.databaseId }]);
            await refreshMeta();
            if (!inline) open(result.databaseId);
            return result.page;
          });
          return;
        }
        case "page": {
          const current = pageRef.current;
          if (!current) return;
          // ⌘⌥9 把一行变成子页面:这一行的文字就是页面标题。
          const nowBlock = live(block.id) ?? block;
          const lineText = hasSegments(nowBlock) ? segmentsText(nowBlock.segments).trim() : "";
          const title = lineText || t("knowledgeNewPageTitle");
          if (replace) removeWithHistory([block.id]);
          void client
            .notionCreatePage({ parentId: current.id, title })
            .then(async (created) => {
              // Notion 把子页面放在父页面末尾;本地同样放到末尾,再进入新页面。
              editLocal((blocks) => [...blocks, { id: created.pageId, children: [], kind: "child_page", title, pageId: created.pageId }]);
              await refreshMeta();
              open(created.pageId);
            })
            .catch((error: unknown) => push({ message: error instanceof Error ? error.message : String(error), tone: "danger" }));
          return;
        }
      }
    };
    return {
      focusStore,
      focusTitle: () => focusTitleRef.current(),
      mentionPages: (query) => {
        const needle = query.trim().toLowerCase();
        return flattenTree(treeRef.current ?? [])
          .filter((node) => needle === "" || node.title.toLowerCase().includes(needle))
          .slice(0, 8)
          .map((node) => ({ id: node.id, title: node.title || t("knowledgeUntitled"), object: node.object }));
      },
      pageBlocks: blocksNow,
      pagePath: () => {
        const target = pageRef.current?.id;
        if (!target) return [];
        const path = pathTo(treeRef.current ?? [], target) ?? [];
        return path.map((node) => ({ id: node.id, title: node.title, icon: node.icon }));
      },
      pageTitle: (id) => {
        const node = findNode(treeRef.current ?? [], id);
        return node ? { title: node.title, icon: node.icon } : null;
      },
      openPage: (id) => open(id),
      databaseOps: {
        load: (databaseId) => client.notionDatabase(databaseId),
        cell: (databaseId, rowId, property, value) => client.notionDbCell({ databaseId, rowId, property, value }),
        addRow: async (databaseId, preset) => {
          const before = await client.notionDatabase(databaseId);
          const known = new Set((before?.rows ?? []).map((row) => row.id));
          const next = await client.notionDbAddRow({ databaseId, title: "" });
          const added = next.rows.find((row) => !known.has(row.id));
          return preset && added ? client.notionDbCell({ databaseId, rowId: added.id, property: preset.property, value: preset.value }) : next;
        },
        deleteRow: (databaseId, rowId) => client.notionDbDeleteRow({ databaseId, rowId }),
        schema: (databaseId, change) => client.notionDbSchema({ ...change, databaseId } as Parameters<typeof client.notionDbSchema>[0]),
        open: (id) => open(id),
        fail: (error) => push({ message: error instanceof Error ? error.message : String(error), tone: "danger" }),
      },
      mentionUsers: (query) => {
        const needle = query.trim().toLowerCase();
        return usersRef.current.filter((user) => needle === "" || user.name.toLowerCase().includes(needle)).slice(0, 6);
      },
      openLocalPath: (path) => {
        void openLocalPath(browserWindowBridge(), path)
          .then((result) => {
            if (result === "unsupported") push({ message: t("knowledgeLocalPathUnsupported"), tone: "danger" });
          })
          .catch((error: unknown) => {
            push({ message: t("knowledgeLocalPathOpenFailed", { error: error instanceof Error ? error.message : String(error) }), tone: "danger" });
          });
      },
      insertLinkBlock: (block, kind, url) => {
        const id = newLocalId();
        const model: NotionBlockModel =
          kind === "bookmark"
            ? { id, children: [], kind: "bookmark", url, caption: [] }
            : kind === "embed"
              ? { id, children: [], kind: "embed", url, caption: [] }
              : { id, children: [], kind, url, caption: [], source: "external" };
        placeNew(block, [model], true, true);
      },
      uploadFile,
      isOpen,
      toggleOpen: (id) => setOpen(id, !isOpen(id)),
      addChild: (parentId) => {
        const parent = live(parentId);
        if (!parent) return;
        setOpen(parentId, true);
        const paragraph = emptyParagraph();
        insertWithHistory([paragraph], { parentId, afterId: parent.children[parent.children.length - 1]?.id ?? null });
        requestFocus(paragraph.id, "start");
      },
      selectBlock: (id, extend) => {
        const next = extend ? new Set(selection.current) : new Set<string>();
        if (extend && next.has(id)) next.delete(id);
        else next.add(id);
        (document.activeElement as HTMLElement | null)?.blur?.();
        setSelection(next);
      },
      targetsFor: (id) => (selection.current.has(id) ? topmostSelected(blocksNow(), selection.current) : [id]),
      setColor: (ids, color) => {
        const steps: HistoryStep[] = [];
        for (const id of ids) {
          const prev = live(id);
          if (!prev) continue;
          let next: NotionBlockModel;
          if (prev.kind === "callout") next = { ...prev, color };
          else if (canColorBlock(prev)) {
            const { color: _old, ...rest } = prev;
            next = (color === "default" ? rest : { ...rest, color }) as NotionBlockModel;
          } else continue;
          doSet(id, next);
          steps.push({ undo: () => doSet(id, prev), redo: () => doSet(id, next) });
        }
        if (steps.length > 0) record(compose(steps));
      },
      setToggleable: (block, on) => {
        const prev = live(block.id);
        if (!prev || prev.kind !== "heading") return;
        if (on) setOpen(block.id, true);
        setWithHistory(block.id, { ...prev, toggleable: on });
      },
      patchBlock: (block, next) => {
        const prev = live(block.id) ?? block;
        if (isLocalPending(prev)) {
          // 占位块第一次确定内容(选了图片、填了链接……):这时才写进 Notion。
          const placement = placementOf(blocksNow(), block.id);
          if (!placement) return;
          editLocal((blocks) => removeBlockIn(blocks, block.id));
          insertWithHistory([{ ...next, id: block.id, children: [] } as NotionBlockModel], placement);
          return;
        }
        setWithHistory(block.id, next);
      },
      discardPending: (blockId) => {
        editLocal((blocks) => removeBlockIn(blocks, blockId));
      },
      insertSpecial: special,
      removeBlocks: (ids) => {
        removeWithHistory(ids);
        setSelection([]);
      },
      duplicateBlocks: (ids) => {
        const steps: HistoryStep[] = [];
        for (const id of [...ids].reverse()) {
          const source = live(id);
          if (!source || !canMoveBlock(source)) continue;
          const cloneOf = new Map<string, string>();
          const clone = cloneWithIds(source, cloneOf);
          doCopy(id, clone, cloneOf);
          let snapshot: { model: NotionBlockModel; placement: BlockPlacement } | null = null;
          steps.push({
            undo: () => {
              const blocks = blocksNow();
              const model = findBlockIn(blocks, clone.id);
              const placement = placementOf(blocks, clone.id);
              snapshot = model && placement ? { model, placement } : null;
              doRemove([clone.id]);
            },
            redo: () => {
              if (snapshot) doRestore([snapshot]);
            },
          });
        }
        if (steps.length > 0) record(compose(steps));
      },
      copyBlocks: (ids) => {
        const blocks = blocksNow();
        const models = topmostSelected(blocks, new Set(ids))
          .map((id) => findBlockIn(blocks, id))
          .filter((model): model is NotionBlockModel => model !== null);
        void navigator.clipboard
          .writeText(blocksToMarkdownText(models))
          .then(() => push({ message: t("knowledgeCopied", { count: models.length }), tone: "success" }))
          .catch((error: unknown) => push({ message: error instanceof Error ? error.message : String(error), tone: "danger" }));
      },
      pasteFiles: (block, files) => {
        let anchor = block;
        const replace = block.kind === "paragraph" && hasSegments(block) && segmentsText(block.segments) === "";
        for (const file of files) {
          const kind = fileKind(file);
          const id = newLocalId();
          // 先放一个「上传中」的占位,上传完成再写进 Notion。
          const placeholder: NotionBlockModel =
            kind === "file" || kind === "pdf"
              ? { id, children: [], kind, url: "", name: file.name, caption: [] }
              : { id, children: [], kind, url: "", caption: [] };
          const placement = after(anchor.id);
          editLocal((blocks) => insertAtPlacement(blocks, placement, [placeholder]));
          anchor = placeholder;
          push({ message: t("knowledgeMediaUploading", { name: file.name }), tone: "info" });
          void uploadFile(file)
            .then((uploadId) => {
              const now = live(id);
              const where = placementOf(blocksNow(), id);
              if (!now || !where) return;
              editLocal((blocks) => removeBlockIn(blocks, id));
              insertWithHistory([{ ...now, uploadId, source: "file" } as NotionBlockModel], where);
            })
            .catch((error: unknown) => {
              editLocal((blocks) => removeBlockIn(blocks, id));
              push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
            });
        }
        if (replace) removeWithHistory([block.id]);
      },
      tableEdit: (block, op) => {
        if (block.kind !== "table") return;
        const prev = live(block.id);
        if (!prev || prev.kind !== "table") return;
        applyTable(block.id, op);
        // 反向操作:改行改回去、插入的行删掉、删掉的行插回来、表头切回去、重建回原表。
        const inverse: TableOp | null =
          op.op === "update-row"
            ? { op: "update-row", rowIndex: op.rowIndex, cells: prev.rows[op.rowIndex] ?? [[]] }
            : op.op === "insert-row"
              ? { op: "delete-row", rowIndex: op.afterIndex + 1 }
              : op.op === "delete-row"
                ? { op: "insert-row", afterIndex: op.rowIndex - 1, cells: prev.rows[op.rowIndex] ?? [[]] }
                : op.op === "set-header"
                  ? { op: "set-header", hasHeader: prev.hasHeader, hasRowHeader: prev.hasRowHeader ?? false }
                  : { op: "rebuild", hasHeader: prev.hasHeader, hasRowHeader: prev.hasRowHeader ?? false, rows: prev.rows };
        if (inverse) record({ undo: () => applyTable(block.id, inverse), redo: () => applyTable(block.id, op) });
      },
      saveSegments: (block, segments) => {
        const prev = liveBlock(block.id, block);
        if (!hasSegments(prev)) return Promise.resolve();
        if (JSON.stringify(prev.segments) === JSON.stringify(segments)) return Promise.resolve();
        const before = editLocal((blocks) => updateBlockIn(blocks, block.id, (entry) => withSegments(entry, segments)));
        if (before) {
          syncText(before.id, block.id);
          const next = withSegments(prev, segments);
          record({ undo: () => doSet(block.id, prev), redo: () => doSet(block.id, next) });
        }
        return Promise.resolve();
      },
      saveCode: (blockId, text, language) => {
        const prev = live(blockId);
        if (!prev || prev.kind !== "code") return Promise.resolve();
        setWithHistory(blockId, { ...prev, text, ...(language ? { language } : {}) });
        return Promise.resolve();
      },
      remove: (blockId, focusId) => {
        removeWithHistory([blockId], focusId);
        return Promise.resolve();
      },
      move: (blockId, direction) => {
        const blocks = blocksNow();
        const origin = placementOf(blocks, blockId);
        if (!origin) return Promise.resolve();
        const siblings = origin.parentId === null ? blocks : (findBlockIn(blocks, origin.parentId)?.children ?? []);
        const index = siblings.findIndex((entry) => entry.id === blockId);
        if (direction === "up") {
          if (index <= 0) return Promise.resolve();
          relocateWithHistory([blockId], { parentId: origin.parentId, afterId: siblings[index - 2]?.id ?? null });
        } else {
          const next = siblings[index + 1];
          if (!next) return Promise.resolve();
          relocateWithHistory([blockId], { parentId: origin.parentId, afterId: next.id });
        }
        requestFocus(blockId, "end");
        return Promise.resolve();
      },
      duplicate: (blockId) => {
        const source = live(blockId);
        if (source && canMoveBlock(source)) {
          const cloneOf = new Map<string, string>();
          const clone = cloneWithIds(source, cloneOf);
          doCopy(blockId, clone, cloneOf);
          record({
            undo: () => doRemove([clone.id]),
            redo: () => {
              const again = new Map<string, string>();
              doCopy(blockId, cloneWithIds(source, again), again);
            },
          });
        }
        return Promise.resolve();
      },
      toggleTodo: (block) => {
        const prev = liveBlock(block.id, block);
        if (prev.kind !== "todo") return Promise.resolve();
        const next = { ...prev, checked: !prev.checked };
        const before = editLocal((blocks) => updateBlockIn(blocks, block.id, () => ({ ...next, children: prev.children })));
        if (!before) return Promise.resolve();
        enqueue(before.id, async () => {
          const real = realId(block.id);
          if (!real) return null;
          const now = liveBlock(block.id, next);
          const rich = hasSegments(now) ? now.segments : [];
          sentText.current.set(block.id, JSON.stringify(rich));
          const result = await client.notionUpdateBlock({ blockId: real, markdown: "", rich, checked: next.checked });
          return result.page;
        });
        record({ undo: () => doSet(block.id, prev), redo: () => doSet(block.id, next) });
        return Promise.resolve();
      },
      addBelow: (afterBlockId, kind, openSlash) => {
        const blocks = blocksNow();
        const placement: BlockPlacement =
          afterBlockId === null
            ? { parentId: null, afterId: blocks[blocks.length - 1]?.id ?? null }
            : { parentId: placementOf(blocks, afterBlockId)?.parentId ?? null, afterId: afterBlockId };
        const made = makeLocalBlock(newLocalId(), kind);
        // 分隔线没有文本:光标落到它下面新补的空段落。
        const models = kind === "divider" ? [made, emptyParagraph()] : [made];
        insertWithHistory(models, placement);
        const target = models[models.length - 1]!;
        if (openSlash) focusStore.request({ blockId: target.id, at: "end", slash: true });
        else requestFocus(target.id, "start");
        return Promise.resolve();
      },
      split: (block, head, tail) => {
        const prev = liveBlock(block.id, block);
        const bare = (segments: NotionSegment[]): boolean => segments.every((segment) => segment.text === "");
        // Notion:空的列表项/待办上回车 = 退出列表,变回普通段落。
        if (bare(head) && bare(tail) && (prev.kind === "bulleted" || prev.kind === "numbered" || prev.kind === "todo")) {
          convert(prev, "paragraph");
          requestFocus(block.id, "start");
          return Promise.resolve();
        }
        // 展开的折叠块/可折叠标题:回车新起的是它的第一个子块。
        const intoChildren = isFoldable(prev) && isOpen(prev.id);
        const kind: TurnIntoKind =
          prev.kind === "heading" || intoChildren
            ? "paragraph"
            : (prev.kind as "paragraph" | "bulleted" | "numbered" | "todo" | "quote" | "callout" | "toggle");
        const created = makeLocalBlock(newLocalId(), kind, tail);
        const placement: BlockPlacement = intoChildren
          ? { parentId: block.id, afterId: null }
          : { parentId: placementOf(blocksNow(), block.id)?.parentId ?? null, afterId: block.id };
        const headModel = withSegments(prev, head);
        const before = editLocal((blocks) => updateBlockIn(blocks, block.id, (entry) => withSegments(entry, head)));
        if (!before) return Promise.resolve();
        syncText(before.id, block.id);
        doInsert([created], placement);
        requestFocus(created.id, "start");
        let snapshot: { model: NotionBlockModel; placement: BlockPlacement } | null = null;
        record({
          undo: () => {
            const blocks = blocksNow();
            const model = findBlockIn(blocks, created.id);
            const where = placementOf(blocks, created.id);
            snapshot = model && where ? { model, placement: where } : null;
            doRemove([created.id]);
            doSet(block.id, prev);
          },
          redo: () => {
            doSet(block.id, headModel);
            if (snapshot) doRestore([snapshot]);
          },
        });
        return Promise.resolve();
      },
      merge: (block, prevId) => {
        const blocks = blocksNow();
        const prev = findBlockIn(blocks, prevId);
        const current = liveBlock(block.id, block);
        if (!prev || !hasSegments(prev) || !hasSegments(current) || current.children.length > 0) {
          // 前一块不是文本块(或本块带子块):空块直接删,有字的不动,避免误伤。
          if (hasSegments(current) && segmentsText(current.segments) === "") removeWithHistory([block.id], prevId);
          else if (prev) requestFocus(prevId, "end");
          return Promise.resolve();
        }
        const prevLength = segmentsText(prev.segments).length;
        const merged = withSegments(prev, [...prev.segments, ...current.segments.filter((segment) => segment.text !== "")]);
        const origin = placementOf(blocks, block.id);
        doSet(prevId, merged);
        doRemove([block.id]);
        requestFocus(prevId, prevLength);
        record({
          undo: () => {
            doSet(prevId, prev);
            if (origin) doRestore([{ model: current, placement: origin }]);
          },
          redo: () => {
            doSet(prevId, merged);
            doRemove([block.id]);
          },
        });
        return Promise.resolve();
      },
      turnInto: (block, kind) => {
        convert(block, kind);
        return Promise.resolve();
      },
      paste: (block, head, items, tail) => {
        const prev = liveBlock(block.id, block);
        const tailKind =
          prev.kind === "heading"
            ? ("paragraph" as const)
            : (prev.kind as "paragraph" | "bulleted" | "numbered" | "todo" | "quote" | "callout" | "toggle");
        const hasTail = tail.some((segment) => segment.text !== "");
        const added = pastedToLocal(items, newLocalId);
        if (hasTail) added.push(makeLocalBlock(newLocalId(), tailKind, tail));
        const placement = { parentId: placementOf(blocksNow(), block.id)?.parentId ?? null, afterId: block.id };
        const steps: HistoryStep[] = [];
        if (head) {
          const next = withSegments(prev, head);
          doSet(block.id, next);
          steps.push({ undo: () => doSet(block.id, prev), redo: () => doSet(block.id, next) });
        }
        doInsert(added, placement);
        const ids = added.map((model) => model.id);
        let snapshot: Array<{ model: NotionBlockModel; placement: BlockPlacement }> = [];
        steps.push({
          undo: () => {
            const blocks = blocksNow();
            snapshot = ids
              .map((id) => ({ model: findBlockIn(blocks, id), placement: placementOf(blocks, id) }))
              .filter((item): item is { model: NotionBlockModel; placement: BlockPlacement } => item.model !== null && item.placement !== null);
            doRemove(ids);
          },
          redo: () => doRestore(snapshot),
        });
        if (head === null) {
          const origin = placementOf(blocksNow(), block.id);
          doRemove([block.id]);
          if (origin) steps.push({ undo: () => doRestore([{ model: prev, placement: origin }]), redo: () => doRemove([block.id]) });
        }
        record(compose(steps));
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
        return Promise.resolve();
      },
      indent: (block, caret) => {
        const moved = indentIn(blocksNow(), block.id);
        if (!moved) return Promise.resolve();
        const parent = findBlockIn(blocksNow(), moved.parentId);
        const lastChild = parent?.children.filter((child) => child.id !== block.id).at(-1)?.id ?? null;
        setOpen(moved.parentId, true);
        relocateWithHistory([block.id], { parentId: moved.parentId, afterId: lastChild });
        requestFocus(block.id, caret ?? "end");
        return Promise.resolve();
      },
      outdent: (block, caret) => {
        const moved = outdentIn(blocksNow(), block.id);
        if (!moved) return Promise.resolve();
        relocateWithHistory([block.id], { parentId: placementOf(blocksNow(), moved.afterId)?.parentId ?? null, afterId: moved.afterId });
        requestFocus(block.id, caret ?? "end");
        return Promise.resolve();
      },
      moveToPage: (ids, targetPageId) => {
        const current = pageRef.current;
        if (!current || targetPageId === current.id) return;
        const blocks = blocksNow();
        const top = topmostSelected(blocks, new Set(ids));
        const origins = top.map((id) => ({ id, placement: placementOf(blocks, id), model: findBlockIn(blocks, id) }));
        editLocal((tree) => top.reduce((acc, id) => removeBlockIn(acc, id), tree));
        setSelection([]);
        const sourcePage = current.id;
        enqueue(sourcePage, async () => {
          const reals = top.map((id) => realId(id));
          if (reals.some((real) => !real)) return null;
          const result = await client.notionRelocateBlocks({ blockIds: reals as string[], mode: "move", targetPageId, atStart: false });
          for (const [from, to] of result.idMap ?? []) learnId(realToLocal.current.get(from) ?? from, to);
          // 目标页面在内存里的旧版本作废,下次打开按索引重读。
          pageMemo.current.delete(targetPageId);
          return result.page;
        });
        push({ message: t("knowledgeMovedTo", { title: findNode(treeRef.current ?? [], targetPageId)?.title || t("knowledgeUntitled") }), tone: "success" });
        // 撤销:从目标页面移回原位置。
        record({
          undo: () => {
            for (const origin of origins) {
              if (!origin.model || !origin.placement) continue;
              const placement = origin.placement;
              const model = origin.model;
              editLocal((tree) => insertAtPlacement(tree, placement, [model]));
              enqueue(sourcePage, async () => {
                const real = realId(origin.id);
                if (!real) return null;
                const dest = serverPlacement(placement) ?? { atStart: false };
                const result = await client.notionRelocateBlocks({ blockIds: [real], mode: "move", targetPageId: sourcePage, ...dest });
                for (const [from, to] of result.idMap ?? []) learnId(realToLocal.current.get(from) ?? from, to);
                pageMemo.current.delete(targetPageId);
                return result.page;
              });
            }
          },
          redo: () => undefined,
        });
      },
      /** 拖拽排序与多块移动(不在接口里暴露给行组件,由页面级的拖放处理调用)。 */
      relocateBlocks: (ids: string[], target: BlockPlacement) => relocateWithHistory(ids, target),
    };
  }, [client, commitPage, editLocal, enqueue, focusStore, learnId, liveBlock, newLocalId, open, push, realId, record, refreshMeta, requestFocus, setSelection, t]);

  // 退出 App 时(托盘「退出」)先把正在编辑的内容提交,并等保存队列写完,不丢字。
  useEffect(() => {
    const flush = async (): Promise<void> => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      if (titleTarget.current) endTitleEditRef.current("save");
      // 表格单元格、段落的防抖保存在失焦后才入队,稍等一下再看队列。
      await new Promise((resolve) => setTimeout(resolve, 1000));
      for (let i = 0; i < 400 && (pendingJobs.current > 0 || titleInFlight.current > 0); i += 1) {
        await Promise.all([queue.current, titleQueue.current]).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      flushKnowledgeCache();
    };
    window.__youBrainBeforeQuit = flush;
    return () => {
      if (window.__youBrainBeforeQuit === flush) delete window.__youBrainBeforeQuit;
    };
  }, []);

  /**
   * ⌘Z / ⌘⇧Z:先让正在编辑的行把还没记录的输入提交成一步(不失焦),再撤销/重做一步。
   * 撤销后光标留在这一行:文字变了落在变化处,没变回到原位。
   */
  const runHistory = useCallback(
    (direction: "undo" | "redo"): void => {
      const active = document.activeElement as HTMLElement | null;
      const editing = active?.isContentEditable ? active : null;
      const rowId = editing?.closest<HTMLElement>("[data-block-id]")?.dataset.blockId;
      editing?.dispatchEvent(new Event(COMMIT_EVENT));
      const caret = editing ? caretOffsetIn(editing) : null;
      const prevText = editing?.textContent ?? undefined;
      const stacks = history.current;
      const step = direction === "undo" ? stacks.past.pop() : stacks.future.pop();
      if (!step) return;
      // 同步提交这一步造成的状态变化,随后的聚焦请求读到的就是撤销后的块。
      flushSync(() => step[direction]());
      (direction === "undo" ? stacks.future : stacks.past).push(step);
      if (rowId && findBlockIn(pageRef.current?.blocks ?? [], rowId)) {
        focusStore.request({ blockId: rowId, at: caret ?? "end", refresh: true, ...(prevText !== undefined ? { prevText } : {}) });
      }
    },
    [focusStore],
  );
  const blocksContainer = useRef<HTMLDivElement>(null);
  const assetBase = useCallback((blockId: string): string => client.notionAssetUrl(blockId), [client]);
  useBlockInteractions({
    container: blocksContainer,
    editor,
    selection,
    setSelection,
    blocks: () => pageRef.current?.blocks ?? [],
    undo: () => runHistory("undo"),
    redo: () => runHistory("redo"),
    enabled: page !== null,
  });
  // 块列表或折叠状态变了(行被新建/重挂载)才把多选状态重新画到行上;选区变化时 setSelection 自己会画。
  const pageBlocks = page?.blocks;
  useEffect(() => {
    paintSelection();
  }, [paintSelection, pageBlocks, openToggles]);

  // —— 页面图标与封面 ——
  const [iconPicking, setIconPicking] = useState(false);
  const [coverPanel, setCoverPanel] = useState(false);
  const [coverDraft, setCoverDraft] = useState("");
  const setPageMeta = useCallback(
    (patch: { icon?: { emoji: string } | null; cover?: { url: string } | { uploadId: string } | null }, optimistic: Partial<NotionPageView>): void => {
      const current = pageRef.current;
      if (!current) return;
      const pageId = current.id;
      commitPage({ ...current, ...optimistic });
      void client
        .notionPageMeta({ pageId, ...patch })
        .then(async (result) => {
          const live = pageRef.current;
          if (live?.id === pageId) commitPage({ ...live, icon: result.page.icon, coverUrl: result.page.coverUrl });
          await refreshMeta();
        })
        .catch((error: unknown) => {
          push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
          const live = pageRef.current;
          if (live?.id === pageId) commitPage({ ...live, icon: current.icon, coverUrl: current.coverUrl });
        });
    },
    [client, commitPage, push, refreshMeta],
  );
  const setPageIcon = useCallback(
    (emoji: string | null): void => {
      const prev = pageRef.current?.icon ?? null;
      const apply = (value: string | null): void => setPageMeta({ icon: value === null ? null : { emoji: value } }, { icon: value });
      apply(emoji);
      record({ undo: () => apply(prev), redo: () => apply(emoji) });
    },
    [record, setPageMeta],
  );
  const uploadCover = useCallback(
    (file: File): void => {
      setCoverPanel(false);
      push({ message: t("knowledgeMediaUploading", { name: file.name }), tone: "info" });
      void editor
        .uploadFile(file)
        .then((uploadId) => setPageMeta({ cover: { uploadId } }, { coverUrl: URL.createObjectURL(file) }))
        .catch((error: unknown) => push({ message: error instanceof Error ? error.message : String(error), tone: "danger" }));
    },
    [editor, push, setPageMeta, t],
  );

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
    // 刚打的字可能还在防抖里没进块模型:以屏幕上这一行的实际文字为准。
    const onScreen = last
      ? document.querySelector<HTMLElement>(`.knowledge-blocks [data-block-id="${CSS.escape(last.id)}"] .nb-editable`)?.textContent ?? null
      : null;
    const emptyTail =
      last !== undefined &&
      last.kind === "paragraph" &&
      last.children.length === 0 &&
      (onScreen ?? last.segments.map((segment) => segment.text).join("")).trim() === "";
    if (last && emptyTail) requestFocus(last.id, "end");
    else void editor.addBelow(null, "paragraph");
  }, [editor, requestFocus]);

  // —— 页面标题 ——
  /** 写回标题:本地先改(侧栏/标题立刻生效),再串行写 Notion;空标题不写。 */
  const saveTitle = useCallback(
    (pageId: string, raw: string): void => {
      const next = raw.trim();
      if (next === "" || titleSent.current.get(pageId) === next) return;
      titleSent.current.set(pageId, next);
      const current = pageRef.current;
      if (current?.id === pageId) commitPage({ ...current, title: next });
      titleInFlight.current += 1;
      titleQueue.current = titleQueue.current
        .then(async () => {
          const result = await client.notionPatchTitle({ pageId, title: next });
          // 写完立刻回读的标题可能还是旧的;以最后一次发出的标题为准,避免标题倒退。
          const latest = titleSent.current.get(pageId) ?? next;
          const live = pageRef.current;
          if (live?.id === pageId) {
            commitPage({ ...live, title: latest });
            writeKnowledgeCache({ pageId, page: { ...result.page, title: latest, blocks: live.blocks } });
          }
          await refreshMeta();
        })
        .catch((error: unknown) => {
          titleSent.current.delete(pageId);
          push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
        })
        .finally(() => {
          titleInFlight.current -= 1;
        });
    },
    [client, commitPage, push, refreshMeta],
  );
  const beginTitleEdit = useCallback((pageId: string, title: string): void => {
    titleTarget.current = { pageId, origin: title };
    titleSent.current.set(pageId, title);
    titleDraftRef.current = title;
    setTitleDraft(title);
    setTitleEditing(true);
  }, []);
  /** 结束编辑:save 写回当前草稿,revert 写回开始编辑时的标题(自动保存可能已经写过)。可重复调用。 */
  const endTitleEdit = useCallback(
    (mode: "save" | "revert"): void => {
      if (titleTimer.current) clearTimeout(titleTimer.current);
      titleTimer.current = null;
      const target = titleTarget.current;
      titleTarget.current = null;
      setTitleEditing(false);
      if (target) saveTitle(target.pageId, mode === "revert" ? target.origin : titleDraftRef.current);
    },
    [saveTitle],
  );
  endTitleEditRef.current = endTitleEdit;
  focusTitleRef.current = () => {
    const current = pageRef.current;
    if (current) beginTitleEdit(current.id, current.title);
  };
  const changeTitle = (value: string): void => {
    titleDraftRef.current = value;
    setTitleDraft(value);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    const tick = (): void => {
      // 组词中的拼音还不是标题,等输入法落字再存。
      if (titleIme.isComposingNow()) {
        titleTimer.current = setTimeout(tick, 400);
        return;
      }
      titleTimer.current = null;
      const target = titleTarget.current;
      if (target) saveTitle(target.pageId, titleDraftRef.current);
    };
    titleTimer.current = setTimeout(tick, 500);
  };
  /** 标题上回车:在正文最前面新起一行(带上光标后的标题文字),光标落过去。 */
  const insertFirstLine = useCallback(
    (text: string): void => {
      const id = newLocalId();
      const segments = text === "" ? [] : plainSegments(text);
      const before = editLocal((blocks) => [makeLocalBlock(id, "paragraph", segments), ...blocks]);
      if (!before) return;
      requestFocus(id, "start");
      enqueue(before.id, async () => {
        const result = await client.notionAppendBlock({
          pageId: before.id,
          atStart: true,
          markdown: "",
          kind: "paragraph",
          ...(segments.length > 0 ? { rich: segments } : {}),
        });
        const created = result.page.blocks[0];
        if (created) learnId(id, created.id);
        return result.page;
      });
    },
    [client, editLocal, enqueue, learnId, newLocalId, requestFocus],
  );
  /** 标题末尾按 ↓:光标进正文第一行;正文没有可编辑行就补一行。 */
  const focusFirstLine = useCallback((): void => {
    const first = document.querySelector<HTMLElement>(".knowledge-blocks [contenteditable='true']");
    if (!first) {
      tailLine();
      return;
    }
    first.focus();
    setCaretAtOffset(first, 0);
  }, [tailLine]);
  const onTitleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    // 输入法组词期间的回车/方向键是在选词。
    if (titleIme.isComposing(event)) {
      if (event.key === "Enter") event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      endTitleEdit("revert");
      return;
    }
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    const input = event.currentTarget;
    const value = input.value;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? start;
    if (event.key === "Enter") {
      event.preventDefault();
      // 光标后的文字移到正文新行;光标在最前面时不拆标题,只新起空行。
      const head = value.slice(0, start);
      const split = head.trim() !== "";
      if (split) titleDraftRef.current = head;
      endTitleEdit("save");
      insertFirstLine(split ? value.slice(end).trim() : "");
      return;
    }
    if (event.key === "ArrowDown" && start === end && end === value.length) {
      event.preventDefault();
      endTitleEdit("save");
      focusFirstLine();
    }
  };
  // 切到别的页面(⌘P、搜索结果等)时,正在编辑的标题先存回原页面。
  useEffect(() => {
    const target = titleTarget.current;
    if (page && target && target.pageId !== page.id) endTitleEdit("save");
  }, [page?.id, endTitleEdit]);
  // 进入编辑(点击、从正文按 ↑)时,光标放到标题末尾。
  useEffect(() => {
    if (!titleEditing) return;
    const input = titleInput.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [titleEditing, page?.id]);

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
      ref={rootRef}
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
                  beginTitleEdit(created.pageId, created.view?.title ?? t("knowledgeUntitled"));
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
                    <span className="knowledge-tree-title">
                      <PageGlyph icon={null} object="page" /> {hit.title || t("knowledgeUntitled")}
                    </span>
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
                    beginTitleEdit(created.pageId, created.view?.title ?? t("knowledgeUntitled"));
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
              onDuplicate={(id) => {
                setBusy(true);
                void client
                  .notionDuplicatePage({ pageId: id, suffix: t("knowledgeCopySuffix") })
                  .then((result) => {
                    setRoots(result.roots);
                    open(result.pageId);
                  })
                  .catch((error: unknown) => push({ message: error instanceof Error ? error.message : String(error), tone: "danger" }))
                  .finally(() => setBusy(false));
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
      <section className="knowledge-main" data-wide={wide ? "true" : "false"}>
        {database ? (
          <DatabaseView
            database={database}
            t={t}
            untitled={t("knowledgeUntitled")}
            onOpen={open}
            onCell={(rowId, property, value, display) => {
              // 先改本地(立刻可见),再写回 Notion;失败时恢复成 Notion 的版本。
              setDatabase((current) =>
                current
                  ? {
                      ...current,
                      rows: current.rows.map((row) =>
                        row.id !== rowId
                          ? row
                          : {
                              ...row,
                              title: current.columns.find((column) => column.name === property)?.type === "title" ? display : row.title,
                              cells: row.cells.map((cell) => (cell.name === property ? { ...cell, text: display } : cell)),
                            },
                      ),
                    }
                  : current,
              );
              void client
                .notionDbCell({ databaseId: database.databaseId, rowId, property, value })
                .then((next) => setDatabase(next))
                .catch((error: unknown) => {
                  push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
                  void client.notionDatabase(database.databaseId).then(setDatabase).catch(() => undefined);
                });
            }}
            onAddRow={(preset) => {
              const known = new Set(database.rows.map((row) => row.id));
              void client
                .notionDbAddRow({ databaseId: database.databaseId, title: "" })
                .then(async (next) => {
                  setDatabase(next);
                  // 看板里在某一列「新建」:新行直接落在这一列。
                  const added = next.rows.find((row) => !known.has(row.id));
                  if (preset && added) setDatabase(await client.notionDbCell({ databaseId: database.databaseId, rowId: added.id, property: preset.property, value: preset.value }));
                  await refreshMeta();
                })
                .catch((error: unknown) => push({ message: error instanceof Error ? error.message : String(error), tone: "danger" }));
            }}
            onSchema={(change) => {
              void client
                .notionDbSchema({ ...change, databaseId: database.databaseId } as Parameters<typeof client.notionDbSchema>[0])
                .then((next) => setDatabase(next))
                .catch((error: unknown) => push({ message: error instanceof Error ? error.message : String(error), tone: "danger" }));
            }}
            onDeleteRow={(rowId) => {
              setDatabase((current) => (current ? { ...current, rows: current.rows.filter((row) => row.id !== rowId) } : current));
              void client
                .notionDbDeleteRow({ databaseId: database.databaseId, rowId })
                .then(async (next) => {
                  setDatabase(next);
                  await refreshMeta();
                })
                .catch((error: unknown) => {
                  push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
                  void client.notionDatabase(database.databaseId).then(setDatabase).catch(() => undefined);
                });
            }}
          />
        ) : page ? (
          <article className="knowledge-page">
            {saveState === "error" || (saveState === "saving" && savingVisible) ? (
              <div className="knowledge-save-state" data-state={saveState} role="status">
                {saveState === "saving" ? t("knowledgeSaving") : t("knowledgeSaveFailed")}
              </div>
            ) : null}
            {page.coverUrl ? (
              <div className="knowledge-cover" style={{ backgroundImage: `url("${page.coverUrl.replaceAll('"', "%22")}")` }}>
                <div className="knowledge-cover-actions">
                  <button type="button" onClick={() => setCoverPanel(true)}>
                    {t("knowledgeChangeCover")}
                  </button>
                  <button type="button" onClick={() => setPageMeta({ cover: null }, { coverUrl: null })}>
                    {t("knowledgeRemoveCover")}
                  </button>
                </div>
              </div>
            ) : null}
            {coverPanel ? (
              <>
                <div className="nb-scrim" onClick={() => setCoverPanel(false)} role="presentation" />
                <form
                  className="nb-source knowledge-cover-panel"
                  onKeyDown={(event) => {
                    // 回车自己处理:WebView 里表单的隐式提交不可靠。
                    if (event.key === "Enter" && !event.nativeEvent.isComposing && event.target instanceof HTMLInputElement && event.target.type !== "file") {
                      event.preventDefault();
                      event.currentTarget.requestSubmit();
                    }
                  }}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const url = coverDraft.trim();
                    if (!/^https?:\/\//iu.test(url)) {
                      push({ message: t("knowledgeMediaBadLink"), tone: "danger" });
                      return;
                    }
                    setCoverPanel(false);
                    setCoverDraft("");
                    setPageMeta({ cover: { url } }, { coverUrl: url });
                  }}
                >
                  <label className="nb-source-upload">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) uploadCover(file);
                      }}
                    />
                    <span>{t("knowledgeMediaChooseFile")}</span>
                    <small>{t("knowledgeMediaUploadLimit")}</small>
                  </label>
                  <div className="nb-source-link">
                    <input autoFocus value={coverDraft} placeholder={t("knowledgeCoverLink")} onChange={(event) => setCoverDraft(event.target.value)} />
                    <button type="submit" className="nb-btn primary">
                      {t("knowledgeCoverApply")}
                    </button>
                  </div>
                </form>
              </>
            ) : null}
            <header className="knowledge-page-head">
              <div className="knowledge-page-meta-actions">
                <button type="button" onClick={toggleWide}>
                  {wide ? t("knowledgeWideOff") : t("knowledgeWideOn")}
                </button>
                {!page.icon ? (
                  <button type="button" onClick={() => setIconPicking(true)}>
                    ☺ {t("knowledgeAddIcon")}
                  </button>
                ) : null}
                {!page.coverUrl ? (
                  <button type="button" onClick={() => setCoverPanel(true)}>
                    🖼 {t("knowledgeAddCover")}
                  </button>
                ) : null}
              </div>
              {page.icon ? (
                <button type="button" className="knowledge-page-icon" onClick={() => setIconPicking(true)}>
                  {page.icon}
                </button>
              ) : null}
              {iconPicking ? (
                <EmojiPicker
                  t={t}
                  onPick={(emoji) => {
                    setIconPicking(false);
                    setPageIcon(emoji);
                  }}
                  {...(page.icon ? { onRemove: () => {
                    setIconPicking(false);
                    setPageIcon(null);
                  } } : {})}
                  onClose={() => setIconPicking(false)}
                />
              ) : null}
              {titleEditing ? (
                <form className="knowledge-title-form" onSubmit={(event) => event.preventDefault()}>
                  <input
                    ref={titleInput}
                    className="knowledge-title-input"
                    value={titleDraft}
                    autoFocus
                    onChange={(event) => changeTitle(event.target.value)}
                    onCompositionStart={titleIme.onCompositionStart}
                    onCompositionEnd={titleIme.onCompositionEnd}
                    onKeyDown={onTitleKeyDown}
                    onBlur={() => endTitleEdit("save")}
                  />
                </form>
              ) : (
                <h1
                  className="knowledge-title-editable"
                  title={t("knowledgeEdit")}
                  onClick={() => beginTitleEdit(page.id, page.title)}
                >
                  {page.title}
                </h1>
              )}
              {page.database ? (
                <dl className="knowledge-properties">
                  {page.database.columns
                    .filter((column) => column.type !== "title")
                    .map((column) => (
                      <div key={column.name} className="knowledge-property">
                        <dt>{column.name}</dt>
                        <dd>
                          <PropertyCell
                            column={column}
                            text={page.properties?.[column.name] ?? ""}
                            t={t}
                            placeholder={t("knowledgeDbEmptyValue")}
                            onChange={(value, display) => {
                              const current = pageRef.current;
                              const databaseId = page.database?.id;
                              if (!current || !databaseId) return;
                              // 先改本地,再写回 Notion。
                              commitPage({ ...current, properties: { ...(current.properties ?? {}), [column.name]: display } });
                              void client
                                .notionDbCell({ databaseId, rowId: current.id, property: column.name, value })
                                .catch((error: unknown) => push({ message: error instanceof Error ? error.message : String(error), tone: "danger" }));
                            }}
                          />
                        </dd>
                      </div>
                    ))}
                </dl>
              ) : page.properties && Object.keys(page.properties).length > 0 ? (
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
              ref={blocksContainer}
              className="knowledge-blocks"
              onClick={(event) => {
                // Notion 习惯:点正文空白处,光标落到文末可编辑行。
                const target = event.target as HTMLElement;
                // 点页面提及:在应用内打开那一页(可编辑正文里的提及是 data-mention,只读视图是 data-page-link)。
                const linked = mentionedPageId(target);
                if (linked) {
                  event.preventDefault();
                  open(linked);
                  return;
                }
                if (target.closest("a, button, [contenteditable], .nb-menu, .nb-code, .knowledge-properties, .knowledge-title-form")) return;
                if (target !== event.currentTarget) return;
                // 只有点在最后一行下方的空白才落到文末;行与行之间的缝隙别把光标拽走。
                const rows = event.currentTarget.querySelectorAll(".nb-row");
                const lastRow = rows[rows.length - 1];
                if (lastRow && event.clientY < lastRow.getBoundingClientRect().bottom) return;
                tailLine();
              }}
            >
              <OpenStateContext.Provider value={openToggles}>
                <BlockList blocks={page.blocks} t={t} assetBase={assetBase} editor={editor} />
              </OpenStateContext.Provider>
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
              {/* Notion:正文下方整片空白都能点,点了就落到文末行(没有就新起一行)。 */}
              <div
                className="knowledge-tail-space"
                aria-hidden="true"
                onMouseDown={(event) => {
                  event.preventDefault();
                  tailLine();
                }}
              />
            </div>
          </article>
        ) : loading ? (
          <div className="knowledge-skeleton" role="status" aria-label={t("knowledgeLoading")}>
            {Array.from({ length: 7 }, (_, index) => (
              <span key={index} />
            ))}
          </div>
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
  onDuplicate,
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
  onDuplicate: (id: string) => void;
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
                  <Icon name="chevron-right" size={12} />
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
                  <PageGlyph icon={node.icon} object={node.object} /> {node.title || untitled}
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
                    disabled={busy || node.object !== "page"}
                    onClick={() => {
                      setMenuFor(null);
                      onDuplicate(node.id);
                    }}
                  >
                    ⧉ {t("knowledgeDuplicate")}
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
                onDuplicate={onDuplicate}
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
                <PageGlyph icon={page.icon} object={page.object} /> {page.title}
              </button>
            </li>
          ))}
          {results.length === 0 ? <li className="knowledge-hint">{emptyText}</li> : null}
        </ul>
      </div>
    </div>
  );
}


/** 焦点是否正在知识库正文的可编辑行里。 */
function mentionedPageId(target: HTMLElement): string | null {
  const link = target.closest<HTMLElement>("[data-page-link]");
  if (link?.dataset.pageLink) return link.dataset.pageLink;
  const raw = target.closest<HTMLElement>("[data-mention]")?.dataset.mention;
  if (!raw) return null;
  try {
    const mention = JSON.parse(raw) as Record<string, unknown>;
    const type = typeof mention.type === "string" ? mention.type : "";
    if (type !== "page" && type !== "database") return null;
    const id = (mention[type] as { id?: unknown } | undefined)?.id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/** 页面/数据库的小图标:有 emoji 用 emoji,没有就用统一的线性图标。 */
function PageGlyph({ icon, object }: { icon: string | null | undefined; object: "page" | "database" }): ReactNode {
  if (icon) return <span className="knowledge-glyph">{icon}</span>;
  return (
    <span className="knowledge-glyph is-default">
      <Icon name={object === "database" ? "table" : "file"} size={14} />
    </span>
  );
}

function isEditingBlocks(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.isContentEditable && active.closest(".knowledge-blocks") !== null;
}

/** 从根到 id 的页面路径(面包屑)。 */
function pathTo(nodes: readonly NotionTreeNodeView[], id: string): NotionTreeNodeView[] | null {
  for (const node of nodes) {
    if (node.id === id) return [node];
    const nested = pathTo(node.children, id);
    if (nested) return [node, ...nested];
  }
  return null;
}

function findNode(nodes: readonly NotionTreeNodeView[], id: string): NotionTreeNodeView | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findNode(node.children, id);
    if (nested) return nested;
  }
  return null;
}
