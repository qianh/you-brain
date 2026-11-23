import { useEffect, useState } from "react";

import { useDaemon } from "../daemon-context.js";
import { ConfirmDialog } from "../components/dialog.js";
import { Icon } from "../components/icons.js";
import { Spinner } from "../components/spinner.js";
import { useToast } from "../components/toast.js";
import type { TerminalReference } from "../lib/terminal-reference.js";
import { DeckTty7NewForm, DeckTty7SessionList } from "./deck-tty7-list.js";
import { resolveOpenRequest, sessionTitle, useSessionRename, type Session, type useTty7Sessions } from "./deck-tty7-sessions.js";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 指挥台右侧的 tty7 会话面板：列会话、新建会话、删除会话。
 * 点会话只是请求打开（onOpen），终端本身由整屏终端显示。
 */
export function DeckTty7Panel({ sessions: shared, device = null, onClose, onOpen, activePane, openRequest, onOpenRequestHandled }: {
  /** 指挥台共享的会话数据（由 DshDeckPage 调用一次 useTty7Sessions 后传入）。 */
  sessions: ReturnType<typeof useTty7Sessions>;
  /** 非空表示当前展示的是远端设备的终端会话。 */
  device?: { id: string; name: string } | null;
  onClose: () => void;
  /** 打开某个会话的终端（加入标签并显示）。 */
  onOpen: (pane: number) => void;
  /** 当前显示的会话，用于列表高亮。 */
  activePane: number | null;
  openRequest?: TerminalReference | null;
  onOpenRequestHandled?: (request: TerminalReference) => void;
}) {
  const { client, t } = useDaemon();
  const { push } = useToast();
  const deviceId = device?.id ?? null;
  const { view, error: loadError, reload: loadSessions } = shared;
  const { rename, reportError } = useSessionRename(loadSessions, deviceId);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 新建表单：null 为收起；label 为 null 表示不限项目。 */
  const [creating, setCreating] = useState<{ label: string | null } | null>(null);

  // 切换设备时清理面板里的临时筛选、弹窗和表单状态，免得跨设备误删或用错路径。
  useEffect(() => {
    setFilter("");
    setCreating(null);
    setPendingDelete(null);
    setActionError(null);
  }, [deviceId]);

  // 外部请求打开某个会话：重新加载一次，只用新加载的列表定位（面板刚挂载时内存里的列表可能是旧的）。
  useEffect(() => {
    if (!openRequest) return;
    let cancelled = false;
    void resolveOpenRequest(openRequest, loadSessions).then((result) => {
      if (cancelled) return;
      if (result.pane !== null) onOpen(result.pane);
      setActionError(result.missing ? t("deckTty7ReferenceMissing") : null);
      onOpenRequestHandled?.(openRequest);
    });
    return () => { cancelled = true; };
  }, [openRequest, loadSessions, t, onOpen, onOpenRequestHandled]);

  const sessions = view?.sessions ?? [];

  const deleteSession = async (): Promise<void> => {
    if (busy || pendingDelete === null) return;
    const pane = pendingDelete.pane;
    setBusy(true);
    try {
      await client.deckTty7Delete(pane, deviceId);
      setPendingDelete(null);
      // 重新加载后，整屏终端会把已不存在的会话标签移除。
      await loadSessions();
    } catch (error) {
      push({ message: t("deckTty7DeleteFailed", { detail: message(error) }), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="deck-tty7" aria-label={t("deckTty7Title")}>
      <header className="deck-tty7-head">
        <strong>{t("deckTty7Title")}</strong>
        {device !== null && (
          <span className="deck-tty7-device-badge" title={device.name}>
            <Icon name="monitor" size={12} />
            <span>{device.name}</span>
          </span>
        )}
        <span className="deck-tty7-count">{view?.available === true ? sessions.length : ""}</span>
        <button type="button" className="btn small quiet" disabled={busy || view?.available !== true} onClick={() => {
          setActionError(null);
          setCreating(creating === null ? { label: null } : null);
        }}>
          {creating !== null ? t("deckTty7Cancel") : t("deckTty7New")}
        </button>
        <button type="button" className="btn small quiet" onClick={onClose} aria-label={t("deckTty7Hide")}>
          ✕
        </button>
      </header>

      {loadError !== null && <p className="deck-tty7-error">{loadError}</p>}
      {view === null && loadError === null && (
        <div className="deck-tty7-loading" role="status">
          <Spinner />
          <span>{t("deckTty7Loading")}</span>
        </div>
      )}
      {view !== null && !view.available && (
        <p className="deck-tty7-error">{t("deckTty7Unavailable", { detail: view.detail })}</p>
      )}

      {creating !== null && view?.available === true && (
        <DeckTty7NewForm
          // 换了设备或目标项目要重新取初始路径。
          key={`${deviceId ?? "local"}:${creating.label ?? ""}`}
          view={view}
          sessions={sessions}
          projectLabel={creating.label}
          reload={loadSessions}
          deviceId={deviceId}
          onStarted={(pane) => {
            setCreating(null);
            setFilter("");
            onOpen(pane);
          }}
        />
      )}

      {view?.available === true && (
        <DeckTty7SessionList
          sessions={sessions}
          order={shared.order}
          onMove={shared.move}
          filter={filter}
          onFilterChange={setFilter}
          onOpen={(pane) => {
            setActionError(null);
            onOpen(pane);
          }}
          onRename={rename}
          onRenameError={reportError}
          onDelete={setPendingDelete}
          onStart={(label) => {
            setActionError(null);
            setCreating({ label });
          }}
          activePane={activePane}
          busy={busy}
        />
      )}

      {actionError !== null && <p className="deck-tty7-error">{actionError}</p>}
      <ConfirmDialog
        open={pendingDelete !== null}
        tone="danger"
        title={t("deckTty7Delete")}
        description={pendingDelete === null ? "" : t("deckTty7DeleteConfirm", { name: sessionTitle(pendingDelete), pane: pendingDelete.pane })}
        confirmLabel={t("deckTty7Delete")}
        cancelLabel={t("deckTty7Cancel")}
        loading={busy}
        onClose={() => { if (!busy) setPendingDelete(null); }}
        onConfirm={() => void deleteSession()}
      />
    </aside>
  );
}
