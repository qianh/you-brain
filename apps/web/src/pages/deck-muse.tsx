import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type {
  DeckMuseOverviewResponse,
  DeckMuseSendBody,
  DeckMuseSessionResponse,
} from "@you-brain/core/http/types.js";

import { Banner } from "../components/banner.js";
import { Button, IconButton } from "../components/button.js";
import { Dialog } from "../components/dialog.js";
import { Icon } from "../components/icons.js";
import { InlineRename, type InlineRenameHandle } from "../components/inline-rename.js";
import { Input } from "../components/input.js";
import { Select } from "../components/select.js";
import { Spinner } from "../components/spinner.js";
import { useToast } from "../components/toast.js";
import { MarkdownView } from "../components/ui.js";
import { useDaemon } from "../daemon-context.js";
import { useImeGuard } from "../lib/ime-guard.js";
import { prefs } from "../lib/prefs.js";
import { usePageActive } from "../page-active.js";

const MUSE_SESSION_PREF_KEY = "you-brain.deck.muse-session";
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

type SupportedMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

interface PendingImage {
  id: string;
  filename: string;
  mimeType: SupportedMime;
  dataBase64: string;
  previewUrl: string;
}

function formatClockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function readImageFile(file: File): Promise<PendingImage | null> {
  let mime = file.type.toLowerCase();
  if (!mime && file.name.includes(".")) {
    const ext = file.name.split(".").at(-1)?.toLowerCase() ?? "";
    if (ext === "jpg" || ext === "jpeg") mime = "image/jpeg";
    else if (ext === "png") mime = "image/png";
    else if (ext === "gif") mime = "image/gif";
    else if (ext === "webp") mime = "image/webp";
  }
  if (!ALLOWED_MIMES.has(mime) || file.size === 0 || file.size > MAX_IMAGE_BYTES) {
    return null;
  }
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const dataBase64 = btoa(binary);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    filename: file.name || `image.${mime.split("/")[1] ?? "png"}`,
    mimeType: mime as SupportedMime,
    dataBase64,
    previewUrl: `data:${mime};base64,${dataBase64}`,
  };
}

export function DeckMusePanel({
  active,
  reconnectVersion,
  settingsOpen,
  onSettingsChange,
}: {
  active: boolean;
  reconnectVersion: number;
  settingsOpen: boolean;
  onSettingsChange: (open: boolean) => void;
}) {
  const { client, t } = useDaemon();
  const pageActive = usePageActive();
  const { push } = useToast();
  const ime = useImeGuard();

  const [overview, setOverview] = useState<DeckMuseOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string>(() => {
    try {
      return prefs.getItem(MUSE_SESSION_PREF_KEY) || "main";
    } catch {
      return "main";
    }
  });
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const [session, setSession] = useState<DeckMuseSessionResponse | null>(null);
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [sending, setSending] = useState(false);

  // Pairing inputs
  const [sdkToken, setSdkToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [pairBusy, setPairBusy] = useState(false);

  // Confirmation dialogs
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState(false);

  const messagesRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const renameHandles = useRef(new Map<string, InlineRenameHandle | null>());

  const selectSession = useCallback((id: string) => {
    setSelectedId(id);
    try {
      prefs.setItem(MUSE_SESSION_PREF_KEY, id);
    } catch {
      // Ignore pref write errors.
    }
  }, []);

  const refreshOverviewAndSession = useCallback(
    async (targetSessionId?: string) => {
      try {
        const nextOverview = await client.deckMuse();
        setOverview(nextOverview);
        setLoadError(null);
        const desired = targetSessionId ?? selectedIdRef.current;
        const exists = nextOverview.sessions.some((s) => s.id === desired);
        const resolvedId = exists ? desired : "main";
        if (resolvedId !== desired) selectSession(resolvedId);
        if (nextOverview.paired) {
          const detail = await client.deckMuseSession(resolvedId);
          setSession(detail);
        } else {
          setSession(null);
        }
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    },
    [client, selectSession],
  );

  // Initial load & live SSE stream when Deck Muse tab is visible.
  const visible = pageActive && active;
  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    const controller = new AbortController();
    void refreshOverviewAndSession();

    void (async () => {
      while (alive && !controller.signal.aborted) {
        try {
          await client.deckMuseStream(
            (event) => {
              if (!alive) return;
              if (event.type === "overview") {
                setOverview(event.overview);
                setLoading(false);
                setLoadError(null);
                if (!event.overview.sessions.some((s) => s.id === selectedIdRef.current)) {
                  selectSession("main");
                }
              } else if (event.type === "session") {
                if (event.session.id === selectedIdRef.current) {
                  setSession(event.session);
                }
              }
            },
            { signal: controller.signal },
          );
        } catch {
          if (!alive || controller.signal.aborted) return;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          controller.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [client, refreshOverviewAndSession, selectSession, visible]);

  // Load selected session transcript whenever selectedId or paired state changes.
  useEffect(() => {
    if (!overview?.paired) return;
    let cancelled = false;
    nearBottomRef.current = true;
    void client
      .deckMuseSession(selectedId)
      .then((detail) => {
        if (!cancelled) setSession(detail);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, overview?.paired, selectedId]);

  // Toolbar reconnect trigger from parent DshDeckPage.
  const prevReconnectRef = useRef(reconnectVersion);
  useEffect(() => {
    if (reconnectVersion === prevReconnectRef.current) return;
    prevReconnectRef.current = reconnectVersion;
    if (!overview?.paired) {
      void refreshOverviewAndSession();
      return;
    }
    void client
      .deckMuseAction({ action: "reconnect" })
      .then(async (res) => {
        setOverview(res.overview);
        const detail = await client.deckMuseSession(selectedIdRef.current);
        setSession(detail);
      })
      .catch((error) => push({ message: error instanceof Error ? error.message : String(error), tone: "danger" }));
  }, [client, overview?.paired, push, reconnectVersion, refreshOverviewAndSession]);

  // Keep scroll anchored to bottom when near bottom.
  useEffect(() => {
    const el = messagesRef.current;
    if (!el || !nearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [session?.messages, session?.busy, session?.activityText]);

  // Auto-size composer textarea.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 38), 160)}px`;
  }, [draft]);

  const handleScroll = (): void => {
    const el = messagesRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  };

  const addFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const incoming = Array.from(fileList);
      if (incoming.length === 0) return;
      const parsed: PendingImage[] = [];
      let rejected = false;
      for (const file of incoming) {
        const img = await readImageFile(file);
        if (img) parsed.push(img);
        else rejected = true;
      }
      if (rejected) push({ message: t("deckMuseImageTooLarge"), tone: "danger" });
      if (parsed.length > 0) {
        setImages((prev) => [...prev, ...parsed].slice(0, 4));
      }
    },
    [push, t],
  );

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files: File[] = [];
    for (const item of Array.from(event.clipboardData.items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      event.preventDefault();
      void addFiles(files);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (event.dataTransfer.files.length === 0) return;
    const hasImages = Array.from(event.dataTransfer.files).some((f) => f.type.startsWith("image/"));
    if (!hasImages) return;
    event.preventDefault();
    void addFiles(event.dataTransfer.files);
  };

  const sendMessage = useCallback(
    async (overrideText?: string) => {
      const textToSend = (overrideText ?? draft).trim();
      if ((!textToSend && images.length === 0) || sending || session?.busy) return;
      setSending(true);
      nearBottomRef.current = true;
      const payload: DeckMuseSendBody = {
        sessionId: selectedId,
        text: textToSend,
        ...(images.length > 0
          ? {
              images: images.map((img) => ({
                filename: img.filename,
                mimeType: img.mimeType,
                dataBase64: img.dataBase64,
              })),
            }
          : {}),
      };
      if (overrideText === undefined) {
        setDraft("");
        setImages([]);
      }
      try {
        const res = await client.deckMuseSend(payload);
        setOverview(res.overview);
        setSession(res.session);
      } catch (error) {
        if (overrideText === undefined) {
          setDraft(textToSend);
        }
        push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
      } finally {
        setSending(false);
      }
    },
    [client, draft, images, push, selectedId, sending, session?.busy],
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (ime.isComposing(event)) return;
    event.preventDefault();
    void sendMessage();
  };

  const startPairing = async (probe: boolean): Promise<void> => {
    setPairBusy(true);
    try {
      const res = await client.deckMuseAction({
        action: "pair-start",
        ...(probe ? { probe: true } : { sdkToken: sdkToken.trim() }),
      });
      setOverview(res.overview);
    } catch (error) {
      push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
    } finally {
      setPairBusy(false);
    }
  };

  const cancelPairing = async (): Promise<void> => {
    try {
      const res = await client.deckMuseAction({ action: "pair-cancel" });
      setOverview(res.overview);
    } catch (error) {
      push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
    }
  };

  const importExisting = async (): Promise<void> => {
    setPairBusy(true);
    try {
      const res = await client.deckMuseAction({ action: "pair-import" });
      setOverview(res.overview);
      await refreshOverviewAndSession("main");
    } catch (error) {
      push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
    } finally {
      setPairBusy(false);
    }
  };

  const createSideSession = async (): Promise<void> => {
    try {
      const res = await client.deckMuseAction({ action: "session-create" });
      setOverview(res.overview);
      if (res.createdSessionId) {
        selectSession(res.createdSessionId);
        if (res.session) setSession(res.session);
        setTimeout(() => textareaRef.current?.focus(), 0);
      }
    } catch (error) {
      push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
    }
  };

  const stopTurn = async (): Promise<void> => {
    if (!session) return;
    try {
      const res = await client.deckMuseAction({ action: "turn-cancel", sessionId: session.id });
      setOverview(res.overview);
      if (res.session) setSession(res.session);
    } catch (error) {
      push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
    }
  };

  const confirmDeleteOrClear = async (): Promise<void> => {
    const id = confirmDeleteId;
    if (!id) return;
    setConfirmDeleteId(null);
    try {
      const res = await client.deckMuseAction({ action: "session-delete", id });
      setOverview(res.overview);
      if (id === selectedId) {
        if (id === "main") {
          const refreshed = await client.deckMuseSession("main");
          setSession(refreshed);
        } else {
          selectSession("main");
        }
      }
    } catch (error) {
      push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
    }
  };

  const performUnpair = async (): Promise<void> => {
    setConfirmUnpair(false);
    onSettingsChange(false);
    try {
      const res = await client.deckMuseAction({ action: "unpair" });
      setOverview(res.overview);
      setSession(null);
    } catch (error) {
      push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
    }
  };

  const sideSessions = useMemo(() => {
    const all = overview?.sessions.filter((s) => s.kind === "side") ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter((s) => s.title.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q));
  }, [filter, overview?.sessions]);

  const mainSummary = useMemo(
    () => overview?.sessions.find((s) => s.kind === "main") ?? null,
    [overview?.sessions],
  );

  if (loading && !overview) {
    return (
      <div className="dsh-deck-state" role="status">
        <Spinner />
        <p>{t("deckMuseStatusConnecting")}</p>
      </div>
    );
  }

  if (loadError && !overview) {
    return (
      <div className="dsh-deck-state" role="status">
        <p className="dsh-deck-error">{loadError}</p>
        <Button size="sm" onClick={() => void refreshOverviewAndSession()}>
          {t("dshDeckRetry")}
        </Button>
      </div>
    );
  }

  if (!overview) return null;

  const pairingActive =
    overview.pairing.state === "compiling" ||
    overview.pairing.state === "advertising" ||
    overview.pairing.state === "connected" ||
    overview.pairing.state === "verifying";

  // ---- Unpaired Onboarding View ----
  if (!overview.paired) {
    return (
      <div className="muse-deck muse-deck-onboarding">
        <div className="muse-onboarding-card">
          <div className="muse-onboarding-badge">
            <Icon name="sparkles" size={18} />
            <span>Muse Gadget SDK · Noise XX</span>
          </div>
          <h2 className="muse-onboarding-title">{t("deckMuseOnboardingTitle")}</h2>
          <p className="muse-onboarding-lead">{t("deckMuseOnboardingLead")}</p>

          {overview.hasExternalPairing && !pairingActive ? (
            <div className="muse-import-box">
              <div className="muse-import-text">
                <Icon name="check-circle" size={16} />
                <span>{t("deckMuseImportBanner")}</span>
              </div>
              <Button size="sm" variant="primary" disabled={pairBusy} onClick={() => void importExisting()}>
                {t("deckMuseImportAction")}
              </Button>
            </div>
          ) : null}

          {overview.pairing.state === "error" && overview.pairing.error ? (
            <Banner tone="danger">{overview.pairing.error}</Banner>
          ) : null}
          {overview.pairing.state === "idle" && overview.pairing.message ? (
            <Banner tone="info">{overview.pairing.message}</Banner>
          ) : null}

          {pairingActive ? (
            <div className="muse-pairing-live" role="status">
              <div className="muse-pairing-head">
                <Spinner />
                <span>{overview.pairing.message ?? t("deckMuseStatusConnecting")}</span>
              </div>
              {overview.pairing.deviceName ? (
                <button
                  type="button"
                  className="muse-device-pill"
                  onClick={() => {
                    void navigator.clipboard?.writeText(overview.pairing.deviceName ?? "");
                  }}
                  title="点击复制设备名称"
                >
                  <code>{overview.pairing.deviceName}</code>
                  <Icon name="copy" size={14} />
                </button>
              ) : null}
              <ol className="muse-pairing-steps">
                <li>{t("deckMusePairStep1")}</li>
                <li>{t("deckMusePairStep2")}</li>
                <li>{t("deckMusePairStep3")}</li>
              </ol>
              <div className="muse-pairing-actions">
                <Button size="sm" variant="ghost" onClick={() => void cancelPairing()}>
                  {t("deckMusePairCancel")}
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="muse-pair-form"
              onSubmit={(event) => {
                event.preventDefault();
                void startPairing(false);
              }}
            >
              <div className="muse-field-head">
                <label htmlFor="muse-sdk-token">{t("deckMuseTokenLabel")}</label>
                <a
                  className="muse-portal-link"
                  href="https://gadgets.muse.ai/settings/sdk-tokens"
                  target="_blank"
                  rel="noreferrer"
                >
                  <span>{t("deckMuseTokenPortal")}</span>
                  <Icon name="external-link" size={12} />
                </a>
              </div>
              <div className="muse-token-row">
                <Input
                  id="muse-sdk-token"
                  type={showToken ? "text" : "password"}
                  value={sdkToken}
                  onChange={(e) => setSdkToken(e.target.value)}
                  placeholder={t("deckMuseTokenPlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                />
                <IconButton
                  label={showToken ? "隐藏 Token" : "显示 Token"}
                  onClick={() => setShowToken((v) => !v)}
                >
                  <Icon name={showToken ? "eye-off" : "eye"} />
                </IconButton>
              </div>
              {!overview.platformSupported ? (
                <p className="muse-pair-note">{t("deckMusePairMacOnly")}</p>
              ) : null}
              <div className="muse-pair-buttons">
                <Button
                  variant="primary"
                  type="submit"
                  disabled={pairBusy || !overview.platformSupported || sdkToken.trim() === ""}
                >
                  {t("deckMusePairStart")}
                </Button>
                <Button
                  variant="ghost"
                  disabled={pairBusy || !overview.platformSupported}
                  onClick={() => void startPairing(true)}
                >
                  {t("deckMusePairProbe")}
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  // ---- Paired Split-Pane Chat View ----
  const activeSession = session ?? {
    id: selectedId,
    kind: selectedId === "main" ? ("main" as const) : ("side" as const),
    title: mainSummary?.title ?? "Muse",
    updatedAt: new Date().toISOString(),
    busy: false,
    messages: [],
  };

  const connectionTone =
    overview.connection === "connected"
      ? "is-connected"
      : overview.connection === "connecting"
        ? "is-connecting"
        : overview.connection === "error"
          ? "is-error"
          : "is-idle";

  const connectionLabel =
    overview.connection === "connected"
      ? t("deckMuseStatusConnected")
      : overview.connection === "connecting"
        ? t("deckMuseStatusConnecting")
        : overview.connection === "error"
          ? t("deckMuseStatusError")
          : t("deckMuseStatusIdle");

  const deletingTarget = confirmDeleteId
    ? overview.sessions.find((s) => s.id === confirmDeleteId) ?? null
    : null;

  return (
    <div
      className="muse-deck"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={handleDrop}
    >
      <aside className="muse-sidebar" aria-label={t("deckMuseSidebarTitle")}>
        <div className="muse-sidebar-head">
          <div className="muse-brand">
            <span className={`muse-conn-dot ${connectionTone}`} aria-hidden="true" />
            <span className="muse-brand-name">Muse</span>
            <span className="muse-conn-text">{connectionLabel}</span>
          </div>
          <IconButton label={t("deckMuseNewChat")} onClick={() => void createSideSession()}>
            <Icon name="plus" />
          </IconButton>
        </div>

        {(overview.sessions.length ?? 0) > 4 ? (
          <div className="muse-sidebar-filter">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("deckMuseSearchPlaceholder")}
              aria-label={t("deckMuseSearchPlaceholder")}
            />
          </div>
        ) : null}

        <div className="muse-sidebar-scroll">
          {mainSummary ? (
            <div className="muse-nav-group">
              <div className="muse-nav-label">{t("deckMuseSectionMain")}</div>
              <button
                type="button"
                className={selectedId === "main" ? "muse-session-item is-active" : "muse-session-item"}
                onClick={() => selectSession("main")}
              >
                <div className="muse-session-top">
                  <Icon name="sparkles" size={14} />
                  <span className="muse-session-title">{mainSummary.title}</span>
                  <span className="muse-sync-pill">{t("deckMuseMainBadge")}</span>
                </div>
                {mainSummary.preview ? (
                  <p className="muse-session-preview">{mainSummary.preview}</p>
                ) : null}
              </button>
            </div>
          ) : null}

          <div className="muse-nav-group">
            <div className="muse-nav-label">{t("deckMuseSectionSide")}</div>
            {sideSessions.length === 0 ? (
              <p className="muse-sidebar-empty">{t("deckMuseNoSideSessions")}</p>
            ) : (
              <ul className="muse-side-list">
                {sideSessions.map((item) => {
                  const selected = selectedId === item.id;
                  return (
                    <li key={item.id} className={selected ? "muse-side-row is-active" : "muse-side-row"}>
                      <button
                        type="button"
                        className="muse-side-select"
                        onClick={() => selectSession(item.id)}
                      >
                        <div className="muse-session-top">
                          {item.busy ? (
                            <span className="muse-busy-dot" aria-hidden="true" />
                          ) : (
                            <Icon name="inbox" size={13} />
                          )}
                          <span className="muse-session-title">
                            <InlineRename
                              value={item.title}
                              label={item.title}
                              controlRef={(handle) => {
                                renameHandles.current.set(item.id, handle);
                              }}
                              onSubmit={async (nextTitle) => {
                                const res = await client.deckMuseAction({
                                  action: "session-rename",
                                  id: item.id,
                                  title: nextTitle,
                                });
                                setOverview(res.overview);
                                if (res.session && res.session.id === selectedIdRef.current) {
                                  setSession(res.session);
                                }
                              }}
                              onError={(err) =>
                                push({
                                  message: err instanceof Error ? err.message : String(err),
                                  tone: "danger",
                                })
                              }
                            />
                          </span>
                        </div>
                        {item.preview ? <p className="muse-session-preview">{item.preview}</p> : null}
                      </button>
                      <div className="muse-side-actions">
                        <IconButton
                          className="muse-row-btn"
                          label={`重命名：${item.title}`}
                          onClick={() => renameHandles.current.get(item.id)?.startEditing()}
                        >
                          <Icon name="pencil" size={13} />
                        </IconButton>
                        <IconButton
                          className="muse-row-btn is-danger"
                          label={`${t("deckMuseDeleteSide")}：${item.title}`}
                          onClick={() => setConfirmDeleteId(item.id)}
                        >
                          <Icon name="trash" size={13} />
                        </IconButton>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="muse-sidebar-foot">
          <span className="muse-foot-vm" title={overview.vm?.id ?? overview.deviceId ?? ""}>
            {overview.vm?.name || overview.vm?.id || overview.deviceId || "Muse"}
          </span>
          <IconButton label={t("deckMuseSettings")} onClick={() => onSettingsChange(true)}>
            <Icon name="settings" size={14} />
          </IconButton>
        </div>
      </aside>

      <section className="muse-stage" aria-label={activeSession.title}>
        <header className="muse-stage-head">
          <div className="muse-stage-meta">
            <h2 className="muse-stage-title">{activeSession.title}</h2>
            <span className="muse-stage-sub">
              {activeSession.kind === "main" ? t("deckMuseMainSubtitle") : t("deckMuseSideSubtitle")}
            </span>
          </div>
          <div className="muse-stage-tools">
            {activeSession.messages.length > 0 || activeSession.kind === "side" ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<Icon name="trash" size={13} />}
                onClick={() => setConfirmDeleteId(activeSession.id)}
              >
                {activeSession.kind === "main" ? t("deckMuseClearMain") : t("deckMuseDeleteSide")}
              </Button>
            ) : null}
          </div>
        </header>

        {overview.warning ? <Banner tone="warn">{overview.warning}</Banner> : null}
        {overview.connection === "error" && overview.connectionError ? (
          <Banner
            tone="danger"
            action={
              <Button
                size="sm"
                onClick={() =>
                  void client
                    .deckMuseAction({ action: "reconnect" })
                    .then((r) => setOverview(r.overview))
                    .catch(() => undefined)
                }
              >
                {t("dshDeckRetry")}
              </Button>
            }
          >
            {overview.connectionError}
          </Banner>
        ) : null}
        {activeSession.error ? <Banner tone="danger">{activeSession.error}</Banner> : null}

        <div className="muse-messages" ref={messagesRef} onScroll={handleScroll}>
          {activeSession.messages.length === 0 ? (
            <div className="muse-empty">
              <div className="muse-empty-icon">
                <Icon name="sparkles" size={20} />
              </div>
              <h3>
                {activeSession.kind === "main"
                  ? t("deckMuseEmptyMainTitle")
                  : t("deckMuseEmptySideTitle")}
              </h3>
              <p>
                {activeSession.kind === "main"
                  ? t("deckMuseEmptyMainHint")
                  : t("deckMuseEmptySideHint")}
              </p>
              <div className="muse-starters">
                {(
                  [
                    t("deckMusePromptToday"),
                    t("deckMusePromptSummary"),
                    t("deckMusePromptDraft"),
                  ] as const
                ).map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    className="muse-starter-chip"
                    disabled={sending || activeSession.busy}
                    onClick={() => void sendMessage(prompt)}
                  >
                    <span>{prompt}</span>
                    <Icon name="arrow-up" size={13} />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="muse-message-list">
              {activeSession.messages.map((msg) =>
                msg.role === "user" ? (
                  <article key={msg.id} className="muse-msg muse-msg-user">
                    <div className="muse-bubble-user">
                      {msg.images && msg.images.length > 0 ? (
                        <div className="muse-msg-images">
                          {msg.images.map((img, i) =>
                            img.dataUrl ? (
                              <img
                                key={`${img.filename}-${i}`}
                                src={img.dataUrl}
                                alt={img.filename}
                                className="muse-msg-thumb"
                              />
                            ) : (
                              <span key={`${img.filename}-${i}`} className="muse-msg-file">
                                <Icon name="file" size={12} /> {img.filename}
                              </span>
                            ),
                          )}
                        </div>
                      ) : null}
                      {msg.text ? <p className="muse-user-text">{msg.text}</p> : null}
                    </div>
                    <div className="muse-msg-meta">
                      {msg.origin === "app" ? (
                        <span className="muse-origin-tag">{t("deckMuseFromApp")}</span>
                      ) : null}
                      <time dateTime={msg.createdAt}>{formatClockTime(msg.createdAt)}</time>
                      {msg.error ? <span className="muse-msg-error">{msg.error}</span> : null}
                    </div>
                  </article>
                ) : (
                  <article key={msg.id} className="muse-msg muse-msg-assistant">
                    <div className="muse-avatar" aria-hidden="true">
                      <Icon name="sparkles" size={14} />
                    </div>
                    <div className="muse-assistant-body">
                      <div className="muse-assistant-content">
                        {msg.text ? <MarkdownView source={msg.text} /> : null}
                        {!msg.done ? <span className="muse-stream-cursor" aria-hidden="true" /> : null}
                      </div>
                      <div className="muse-msg-meta">
                        <span>Muse</span>
                        <time dateTime={msg.createdAt}>{formatClockTime(msg.createdAt)}</time>
                      </div>
                    </div>
                  </article>
                ),
              )}

              {activeSession.busy ? (
                <div className="muse-activity-bar" role="status">
                  <Spinner />
                  <span className="muse-activity-text">
                    {activeSession.activityText || t("deckMuseThinking")}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void stopTurn()}>
                    {t("deckMuseStopTurn")}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <footer className="muse-composer-wrap">
          {images.length > 0 ? (
            <div className="muse-composer-images">
              {images.map((img) => (
                <div key={img.id} className="muse-pending-img">
                  <img src={img.previewUrl} alt={img.filename} />
                  <button
                    type="button"
                    className="muse-pending-remove"
                    aria-label={t("deckMuseRemoveImage")}
                    onClick={() => setImages((prev) => prev.filter((item) => item.id !== img.id))}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="muse-composer">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <IconButton
              label={t("deckMuseAttachImage")}
              disabled={sending || activeSession.busy || images.length >= 4}
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon name="plus" />
            </IconButton>
            <textarea
              ref={textareaRef}
              className="muse-composer-input"
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onCompositionStart={ime.onCompositionStart}
              onCompositionEnd={ime.onCompositionEnd}
              placeholder={t("deckMuseComposerPlaceholder")}
              aria-label={t("deckMuseComposerPlaceholder")}
            />
            <button
              type="button"
              className="muse-send-btn"
              aria-label={t("deckMuseSend")}
              disabled={sending || activeSession.busy || (!draft.trim() && images.length === 0)}
              onClick={() => void sendMessage()}
            >
              <Icon name="arrow-up" size={15} />
            </button>
          </div>
        </footer>
      </section>

      {/* Settings Dialog */}
      <Dialog
        open={settingsOpen}
        onClose={() => onSettingsChange(false)}
        title={t("deckMuseSettingsTitle")}
        description={t("deckMuseSettingsDesc")}
        footer={
          <>
            <Button variant="danger" onClick={() => setConfirmUnpair(true)}>
              {t("deckMuseUnpair")}
            </Button>
            <Button variant="primary" onClick={() => onSettingsChange(false)}>
              OK
            </Button>
          </>
        }
      >
        <div className="muse-settings-body">
          <div className="muse-kv-row">
            <span className="muse-kv-label">{t("deckMuseDeviceLabel")}</span>
            <code>{overview.deviceId ?? "—"}</code>
          </div>
          {overview.sdkTokenHint ? (
            <div className="muse-kv-row">
              <span className="muse-kv-label">{t("deckMuseTokenHintLabel")}</span>
              <code>{overview.sdkTokenHint}…</code>
            </div>
          ) : null}
          {overview.vms.length > 0 ? (
            <div className="muse-vm-field">
              <Select
                label={t("deckMuseVmLabel")}
                value={overview.selectedVmId ?? ""}
                onChange={(val) => {
                  void client
                    .deckMuseAction({ action: "select-vm", vmId: val === "" ? null : val })
                    .then((res) => setOverview(res.overview))
                    .catch((err) =>
                      push({
                        message: err instanceof Error ? err.message : String(err),
                        tone: "danger",
                      }),
                    );
                }}
                options={[
                  { value: "", label: t("deckMuseVmDefault") },
                  ...overview.vms.map((v) => ({
                    value: v.id,
                    label: `${v.name || v.id}${v.isDefault ? " ★" : ""}`,
                  })),
                ]}
              />
            </div>
          ) : null}
        </div>
      </Dialog>

      {/* Delete / Clear Session Confirmation */}
      <Dialog
        open={confirmDeleteId !== null}
        onClose={() => setConfirmDeleteId(null)}
        title={
          confirmDeleteId === "main" ? t("deckMuseClearMain") : t("deckMuseDeleteSide")
        }
        description={
          confirmDeleteId === "main"
            ? t("deckMuseClearMainConfirm")
            : t("deckMuseDeleteSideConfirm", { title: deletingTarget?.title ?? "" })
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDeleteId(null)}>
              {t("deckTty7Cancel")}
            </Button>
            <Button variant="danger" onClick={() => void confirmDeleteOrClear()}>
              {confirmDeleteId === "main" ? t("deckMuseClearMain") : t("deckMuseDeleteSide")}
            </Button>
          </>
        }
      >
        <span />
      </Dialog>

      {/* Unpair Confirmation */}
      <Dialog
        open={confirmUnpair}
        onClose={() => setConfirmUnpair(false)}
        title={t("deckMuseUnpair")}
        description={t("deckMuseUnpairConfirm")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmUnpair(false)}>
              {t("deckTty7Cancel")}
            </Button>
            <Button variant="danger" onClick={() => void performUnpair()}>
              {t("deckMuseUnpair")}
            </Button>
          </>
        }
      >
        <span />
      </Dialog>
    </div>
  );
}
