import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ReferenceCandidateView, ReferenceContentView, ReferenceKind } from "@you-brain/core/http/types.js";

import { Button } from "../components/button.js";
import { Dialog } from "../components/dialog.js";
import { Icon, type IconName } from "../components/icons.js";
import { SearchField } from "../components/input.js";
import { Spinner } from "../components/spinner.js";
import { useToast } from "../components/toast.js";
import { useDaemon } from "../daemon-context.js";
import { modLabel, shortcutMod } from "../lib/shortcuts.js";
import { isReferenceTriggerChar } from "./deck-terminal-input.js";
import { PortraitMarkdown } from "./portrait/markdown-view.js";
import {
  flattenReferenceGroups,
  groupReferenceCandidates,
  moveReferenceSelection,
  writeClipboardDeferred,
} from "./deck-reference-logic.js";

type PreviewState = {
  candidate: ReferenceCandidateView;
  loading: boolean;
  content?: ReferenceContentView;
  error?: string;
} | null;

const KIND_ICON: Record<ReferenceKind, IconName> = {
  tty7: "terminal",
  session: "clock",
  topic: "book",
  kb: "file",
};

export function DeckReferencePicker({
  open,
  mode,
  onClose,
  onInsert,
  onCopied,
  onOpenTerminal,
  onPassthrough,
}: {
  open: boolean;
  /** terminal / t3-insert：选中后直接填进去（onInsert）；t3：T3 没走转发时只能复制到剪贴板。 */
  mode: "terminal" | "t3" | "t3-insert";
  /** 由终端或 T3 里敲 `%` 打开时提供：搜索框空着再敲一个 `%`，表示要输入 % 本身。 */
  onPassthrough?: () => void;
  onClose: () => void;
  onInsert?: (mentionText: string, label: string) => void;
  onCopied?: () => void;
  onOpenTerminal?: (pane: number) => void;
}) {
  const { client, t } = useDaemon();
  const { push } = useToast();
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<ReferenceCandidateView[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [preview, setPreview] = useState<PreviewState>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);
  const mod = shortcutMod(typeof navigator === "undefined" ? "" : navigator.platform);

  const kindTitle = (kind: ReferenceKind): string => {
    if (kind === "tty7") return t("deckRefKindTty7");
    if (kind === "session") return t("deckRefKindSession");
    if (kind === "topic") return t("deckRefKindTopic");
    return t("deckRefKindKb");
  };

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    setPreview(null);
    setSubmitting(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const delay = query.trim() === "" ? 0 : 150;
    const timer = window.setTimeout(() => {
      void client
        .referenceCandidates({ query: query.trim() })
        .then((res) => {
          if (cancelled) return;
          setCandidates(res.candidates);
          setActiveIndex(0);
        })
        .catch(() => {
          if (!cancelled) setCandidates([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query, client]);

  const groups = useMemo(() => groupReferenceCandidates(candidates), [candidates]);
  const flat = useMemo(() => flattenReferenceGroups(groups), [groups]);

  useEffect(() => {
    if (flat.length === 0) {
      setActiveIndex(-1);
    } else if (activeIndex < 0 || activeIndex >= flat.length) {
      setActiveIndex(0);
    }
  }, [flat, activeIndex]);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const loadPreview = (candidate: ReferenceCandidateView): void => {
    setPreview({ candidate, loading: true });
    void client
      .referenceContent({ uri: candidate.uri, label: candidate.label })
      .then((content) => {
        setPreview((current) =>
          current?.candidate.uri === candidate.uri
            ? {
                candidate,
                loading: false,
                content,
                ...(content.error !== undefined ? { error: content.error } : {}),
              }
            : current,
        );
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setPreview((current) =>
          current?.candidate.uri === candidate.uri
            ? { candidate, loading: false, error: message }
            : current,
        );
      });
  };

  const pick = async (candidate: ReferenceCandidateView | undefined): Promise<void> => {
    if (!candidate || submitting) return;
    setSubmitting(true);
    try {
      const materialized = client.materializeReference({
        uri: candidate.uri,
        label: candidate.label,
      });
      // 剪贴板写入要在点击的同一调用栈里发起，不能等接口返回后再写（WebKit 会拒绝）。
      const copying =
        mode !== "t3"
          ? null
          : writeClipboardDeferred(
              materialized.then((value) => `${value.fileMention} `),
              navigator.clipboard,
            );
      const res = await materialized;
      const mentionText = `${res.fileMention} `;
      if (mode !== "t3") {
        onInsert?.(mentionText, candidate.label);
        onClose();
        return;
      }
      const copied = (await copying) ?? false;
      if (copied) {
        push({
          message: t("deckRefCopiedT3", {
            mention: res.fileMention,
            pasteShortcut: `${modLabel(mod)}V`,
          }),
          tone: "success",
        });
      } else {
        push({
          message: t("deckRefCopyFailed", { mention: res.fileMention }),
          tone: "danger",
        });
      }
      onClose();
      onCopied?.();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      push({ message: t("deckRefFailed", { detail }), tone: "danger" });
    } finally {
      setSubmitting(false);
    }
  };

  const selected = activeIndex >= 0 ? flat[activeIndex] : undefined;

  // 右侧预览跟随当前选中的一行（点击或上下键）；稍等一下再取，快速翻动时不逐条请求。
  const previewUri = preview?.candidate.uri;
  useEffect(() => {
    if (!open || !selected || selected.uri === previewUri) return;
    const timer = window.setTimeout(() => loadPreview(selected), 180);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selected?.uri]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => moveReferenceSelection(current, flat.length, 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => moveReferenceSelection(current, flat.length, -1));
      return;
    }
    if (event.key === "Enter") {
      const target = event.target as HTMLElement | null;
      // 焦点在别的按钮（刷新、取消等）上时交给按钮自己；在列表行上回车等同插入。
      if (target?.tagName === "BUTTON" && !target.classList.contains("deck-ref-row")) return;
      if (selected) {
        event.preventDefault();
        void pick(selected);
      }
    }
  };

  let flatCursor = 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      placement="top"
      className="deck-ref-dialog"
      title={t("deckRefDialogTitle")}
      description={t(mode === "terminal" ? "deckRefDialogDescTerminal" : mode === "t3-insert" ? "deckRefDialogDescT3Insert" : "deckRefDialogDescT3")}
      footer={
        <>
          <Button variant="ghost" data-cancel="" onClick={onClose}>
            {t("deckTty7Cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!selected || submitting}
            loading={submitting}
            onClick={() => void pick(selected)}
          >
            {mode === "t3" ? t("deckRefCopyInsert") : t("deckRefInsert")}
          </Button>
        </>
      }
    >
      <div className="deck-ref-picker" onKeyDown={onKeyDown}>
        <SearchField
          value={query}
          onChange={(value) => {
            if (onPassthrough && query === "" && isReferenceTriggerChar(value)) {
              onPassthrough();
              return;
            }
            setQuery(value);
          }}
          placeholder={t("deckRefSearchPlaceholder")}
          label={t("deckRefSearchLabel")}
          autoFocus
        />
        <div className="deck-ref-split">
          <div className="deck-ref-list" role="listbox" aria-label={t("deckRefSearchLabel")}>
            {loading && flat.length === 0 ? (
              <div className="deck-ref-status" role="status">
                <Spinner />
                <span>{t("deckRefLoading")}</span>
              </div>
            ) : flat.length === 0 ? (
              <p className="deck-ref-empty">{t("deckRefEmpty")}</p>
            ) : (
              groups.map((group) => (
                <div key={group.kind} className="deck-ref-group">
                  <div className="deck-ref-group-title">{kindTitle(group.kind)}</div>
                  {group.items.map((item) => {
                    const index = flatCursor++;
                    const isSelected = index === activeIndex;
                    return (
                      <div
                        key={item.uri}
                        className={["deck-ref-item", isSelected ? "is-selected" : ""].filter(Boolean).join(" ")}
                      >
                        <button
                          ref={isSelected ? activeItemRef : undefined}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          className="deck-ref-row"
                          onClick={() => setActiveIndex(index)}
                          onDoubleClick={() => void pick(item)}
                        >
                          <span className="deck-ref-row-icon" aria-hidden="true">
                            <Icon name={KIND_ICON[item.kind]} />
                          </span>
                          <span className="deck-ref-row-main">
                            <span className="deck-ref-row-label">{item.label}</span>
                            {item.detail ? <span className="deck-ref-row-detail">{item.detail}</span> : null}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
          <div className="deck-ref-preview" aria-label={t("deckRefPreviewTitle")}>
            {preview === null ? (
              <p className="deck-ref-preview-empty">{t("deckRefPreviewEmpty")}</p>
            ) : (
              <>
                <div className="deck-ref-preview-head">
                  <strong className="deck-ref-preview-title">
                    {preview.content?.title || preview.candidate.label}
                  </strong>
                  <div className="deck-ref-preview-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Icon name="refresh" />}
                      disabled={preview.loading}
                      onClick={() => loadPreview(preview.candidate)}
                    >
                      {t("deckRefRefresh")}
                    </Button>
                    {preview.content?.terminal && onOpenTerminal ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<Icon name="terminal" />}
                        onClick={() => {
                          const pane = preview.content?.terminal?.pane;
                          if (pane !== undefined) {
                            onClose();
                            onOpenTerminal(pane);
                          }
                        }}
                      >
                        {t("deckRefOpenTerminal")}
                      </Button>
                    ) : null}
                  </div>
                </div>
                {preview.loading ? (
                  <div className="deck-ref-status" role="status">
                    <Spinner />
                    <span>{t("deckRefPreviewLoading")}</span>
                  </div>
                ) : preview.error ? (
                  <p className="deck-ref-preview-error" role="alert">
                    {preview.error}
                  </p>
                ) : preview.candidate.kind === "tty7" ? (
                  <pre className="deck-ref-preview-body">{preview.content?.text}</pre>
                ) : (
                  <div className="deck-ref-preview-body is-markdown">
                    <PortraitMarkdown source={preview.content?.text ?? ""} />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
