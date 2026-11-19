import { useCallback, useEffect, useState } from "react";

import type { DeckTelegramActionBody, DeckTelegramStatusResponse } from "@you-brain/core/http/types.js";

import { Banner } from "../../components/banner.js";
import { Button } from "../../components/button.js";
import { Card, Section } from "../../components/card.js";
import { useToast } from "../../components/toast.js";
import { useDaemon } from "../../daemon-context.js";

/** 等待绑定时轮询状态的间隔：用户在手机上点了「开始」后这里自动显示已绑定。 */
const PAIR_POLL_MS = 3_000;

/** Telegram 桥：Bot Token 或中转、绑定私聊、发送测试。推送「终端会话等你回复」，回复提醒即输入。 */
export function TelegramSection() {
  const { client, t } = useDaemon();
  const { push } = useToast();
  const [token, setToken] = useState("");
  const [relayUrl, setRelayUrl] = useState("");
  const [relayKey, setRelayKey] = useState("");
  const [relayName, setRelayName] = useState("");
  const [status, setStatus] = useState<DeckTelegramStatusResponse | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await client.deckTelegram());
      setUnsupported(false);
    } catch {
      setUnsupported(true);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pairing = status?.pairing ?? null;
  useEffect(() => {
    if (pairing === null) return;
    const timer = setInterval(() => void refresh(), PAIR_POLL_MS);
    return () => clearInterval(timer);
  }, [pairing, refresh]);

  const run = useCallback(
    async (body: DeckTelegramActionBody, success?: (next: DeckTelegramStatusResponse) => string) => {
      setBusy(true);
      try {
        const next = await client.deckTelegramAction(body);
        setStatus(next);
        if (success) push({ message: success(next), tone: "success" });
        return true;
      } catch (error) {
        push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [client, push],
  );

  if (unsupported) return null;

  const connection =
    status === null
      ? ""
      : {
          ok: t("telegramConnOk"),
          connecting: t("telegramConnConnecting"),
          error: t("telegramConnError"),
          off: t("telegramConnOff"),
        }[status.connection];

  const relay = status?.relay ?? null;

  return (
    <Section title={t("telegramTitle")}>
      <Card>
        <div className="notion-form">
          {relay ? null : (
            <>
              <label className="notion-label" htmlFor="telegram-token">
                {t("telegramTokenLabel")}
              </label>
              <div className="notion-token-row">
                <input
                  id="telegram-token"
                  className="notion-input"
                  type="password"
                  autoComplete="off"
                  placeholder={t("telegramTokenPlaceholder")}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
                <Button
                  size="sm"
                  disabled={busy || token.trim() === ""}
                  onClick={() =>
                    void run({ action: "set-token", token: token.trim() }, (next) =>
                      t("telegramSaved", { name: next.bot?.username ?? "" }),
                    ).then((ok) => {
                      if (ok) setToken("");
                    })
                  }
                >
                  {t("telegramSave")}
                </Button>
                {status?.configured ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run({ action: "clear-token" })}>
                    {t("telegramClear")}
                  </Button>
                ) : null}
              </div>
            </>
          )}
          {status?.configured ? (
            <>
              {relay ? (
                <div className="notion-status">
                  <span>
                    {t("telegramRelayCurrent")}: {relay.url}
                  </span>
                  <span>
                    {t("telegramRelayDevices")}:{" "}
                    {relay.devices
                      .map(
                        (device) =>
                          `${device.name}${device.self ? `（${t("telegramRelaySelf")}）` : ""}${device.online ? "" : `（${t("telegramRelayOffline")}）`}`,
                      )
                      .join("、") || "—"}
                  </span>
                </div>
              ) : null}
              <div className="notion-status">
                <span>
                  {t("telegramBot")}: {status.bot ? `@${status.bot.username}` : "—"}
                </span>
                <span>
                  {t("telegramConnection")}: {connection}
                </span>
                <span>{status.bound ? `${t("telegramBound")}: ${status.bound.name}` : t("telegramUnbound")}</span>
              </div>
              <div className="notion-status">
                {status.bound ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void run({ action: "test" }, () => t("telegramTestOk"))}
                    >
                      {t("telegramTest")}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run({ action: "unbind" })}>
                      {t("telegramUnbind")}
                    </Button>
                  </>
                ) : (
                  <Button size="sm" disabled={busy || !status.bot} onClick={() => void run({ action: "pair" })}>
                    {t("telegramPair")}
                  </Button>
                )}
              </div>
              {pairing && !status.bound ? (
                <div className="notion-status">
                  <a href={pairing.link} target="_blank" rel="noreferrer">
                    {pairing.link}
                  </a>
                  <span>{t("telegramPairHint", { code: pairing.code })}</span>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </Card>
      <Card>
        <div className="notion-form">
          <span className="notion-label">{t("telegramRelayTitle")}</span>
          {relay ? (
            <div className="notion-token-row">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run({ action: "clear-relay" })}>
                {t("telegramRelayClear")}
              </Button>
            </div>
          ) : (
            <>
              <label className="notion-label" htmlFor="telegram-relay-url">
                {t("telegramRelayUrl")}
              </label>
              <input
                id="telegram-relay-url"
                className="notion-input"
                type="url"
                autoComplete="off"
                placeholder="https://u-brain-telegram-relay.xxx.workers.dev"
                value={relayUrl}
                onChange={(event) => setRelayUrl(event.target.value)}
              />
              <label className="notion-label" htmlFor="telegram-relay-key">
                {t("telegramRelayKey")}
              </label>
              <input
                id="telegram-relay-key"
                className="notion-input"
                type="password"
                autoComplete="off"
                value={relayKey}
                onChange={(event) => setRelayKey(event.target.value)}
              />
              <label className="notion-label" htmlFor="telegram-relay-name">
                {t("telegramRelayName")}
              </label>
              <div className="notion-token-row">
                <input
                  id="telegram-relay-name"
                  className="notion-input"
                  type="text"
                  autoComplete="off"
                  maxLength={40}
                  value={relayName}
                  onChange={(event) => setRelayName(event.target.value)}
                />
                <Button
                  size="sm"
                  disabled={busy || relayUrl.trim() === "" || relayKey.trim() === ""}
                  onClick={() =>
                    void run(
                      {
                        action: "set-relay",
                        url: relayUrl.trim(),
                        key: relayKey.trim(),
                        ...(relayName.trim() ? { name: relayName.trim() } : {}),
                      },
                      () => t("telegramRelaySaved"),
                    ).then((ok) => {
                      if (ok) setRelayKey("");
                    })
                  }
                >
                  {t("telegramRelaySave")}
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>
      <Banner tone="info">{t("telegramRelayHint")}</Banner>
      <Banner tone="info">{t("telegramHint")}</Banner>
      {status?.error ? <Banner tone="danger">{status.error}</Banner> : null}
    </Section>
  );
}
