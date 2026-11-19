import { prefs } from "../lib/prefs.js";
import { useEffect, useState, type RefObject } from "react";
import { DEFAULT_T3_URL, normalizeT3Url, type T3WebState } from "@you-brain/core/deck/t3/index.js";

import { Button } from "../components/button.js";
import { Dialog } from "../components/dialog.js";
import { Input } from "../components/input.js";
import { Spinner } from "../components/spinner.js";
import { useDaemon } from "../daemon-context.js";
import { t3FrameSrc } from "../lib/t3-frame.js";

const T3_URL_KEY = "you-brain.deck.t3-url";
const SETTINGS_FORM = "deck-t3-settings";
type T3View = T3WebState | { state: "checking" } | { state: "check-error" };

function savedUrl(): string {
  try {
    return normalizeT3Url(prefs.getItem(T3_URL_KEY) ?? "") ?? DEFAULT_T3_URL;
  } catch {
    return DEFAULT_T3_URL;
  }
}

/** 首次切到 T3 时挂载，之后仅隐藏，保留 T3 自己的会话与输入状态。 */
export function DeckT3Panel({
  reloadVersion,
  settingsOpen,
  onSettingsChange,
  onReload,
  frameRef,
  threadUrl,
}: {
  reloadVersion: number;
  settingsOpen: boolean;
  onSettingsChange: (open: boolean) => void;
  onReload: () => void;
  frameRef?: RefObject<HTMLIFrameElement | null>;
  threadUrl: string | null;
}) {
  const { client, t } = useDaemon();
  const [url, setUrl] = useState(savedUrl);
  const [draft, setDraft] = useState(url);
  const [invalid, setInvalid] = useState(false);
  const [view, setView] = useState<T3View>({ state: "checking" });

  useEffect(() => {
    let cancelled = false;
    setView({ state: "checking" });
    void client.deckT3(url).then(
      (next) => { if (!cancelled) setView(next); },
      () => { if (!cancelled) setView({ state: "check-error" }); },
    );
    return () => { cancelled = true; };
  }, [client, url, reloadVersion]);

  useEffect(() => {
    if (!settingsOpen) return;
    setDraft(url);
    setInvalid(false);
  }, [settingsOpen, url]);

  const save = (): void => {
    const next = normalizeT3Url(draft);
    if (next === null) {
      setInvalid(true);
      return;
    }
    setUrl(next);
    try { prefs.setItem(T3_URL_KEY, next); } catch { /* 本次连接仍可用。 */ }
    onSettingsChange(false);
    onReload();
  };

  return (
    <>
      {view.state === "ready" ? (
        <iframe
          ref={frameRef}
          className="dsh-frame"
          src={t3FrameSrc(view, threadUrl)}
          title={t("dshDeckT3FrameTitle")}
          allow="clipboard-read; clipboard-write"
          referrerPolicy="no-referrer"
          onError={() => setView({ state: "check-error" })}
        />
      ) : view.state === "checking" ? (
        <div className="dsh-deck-state" role="status">
          <Spinner />
          <p>{t("dshDeckT3Connecting")}</p>
        </div>
      ) : (
        <div className="dsh-deck-state" role="status">
          <p className="dsh-deck-error">{t(
            view.state === "check-error" ? "dshDeckT3CheckError" :
              view.reason === "not-t3" ? "dshDeckT3WrongService" :
                view.reason === "frame-blocked" ? "dshDeckT3FrameBlocked" : "dshDeckT3Unavailable",
          )}</p>
          <p className="dsh-deck-hint">{t("dshDeckT3StartHint")}</p>
          <code className="dsh-deck-address">{url}</code>
          <div className="dsh-deck-actions">
            <Button size="sm" onClick={onReload}>{t("dshDeckRetry")}</Button>
            <Button size="sm" variant="ghost" onClick={() => onSettingsChange(true)}>{t("dshDeckT3Settings")}</Button>
          </div>
        </div>
      )}
      <Dialog
        open={settingsOpen}
        onClose={() => onSettingsChange(false)}
        title={t("dshDeckT3Settings")}
        description={t("dshDeckT3SettingsHint")}
        footer={
          <>
            <Button variant="ghost" onClick={() => onSettingsChange(false)}>{t("deckTty7Cancel")}</Button>
            <Button variant="primary" type="submit" form={SETTINGS_FORM}>{t("dshDeckT3Connect")}</Button>
          </>
        }
      >
        <form id={SETTINGS_FORM} className="dsh-deck-settings" onSubmit={(event) => { event.preventDefault(); save(); }}>
          <label htmlFor="deck-t3-url">{t("dshDeckT3Address")}</label>
          <Input
            id="deck-t3-url"
            value={draft}
            onChange={(event) => { setDraft(event.target.value); setInvalid(false); }}
            placeholder={DEFAULT_T3_URL}
            autoComplete="off"
            spellCheck={false}
            {...(invalid ? { error: t("dshDeckT3InvalidUrl") } : {})}
          />
        </form>
      </Dialog>
    </>
  );
}
