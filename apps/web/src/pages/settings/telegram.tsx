import { useCallback, useEffect, useState } from "react";

import { decodeRelayInvite } from "@you-brain/core/deck/telegram/invite.js";
import type {
  DeckTelegramActionBody,
  DeckTelegramEnrollInviteResponse,
  DeckTelegramStatusResponse,
} from "@you-brain/core/http/types.js";

import type { BrowserDaemon } from "../../api/client.js";
import { Banner } from "../../components/banner.js";
import { Button } from "../../components/button.js";
import { Card, Section } from "../../components/card.js";
import { Chip } from "../../components/chip.js";
import { useToast } from "../../components/toast.js";
import { useDaemon } from "../../daemon-context.js";

/** 等待绑定时轮询状态的间隔：用户在手机上点了「开始」后这里自动显示已绑定。 */
const PAIR_POLL_MS = 3_000;

export interface RelayEnrollInput {
  url: string;
  code: string;
  name?: string;
}

export interface RelayEnrollResult {
  submitted: boolean;
  ok: boolean;
  status?: DeckTelegramStatusResponse;
  error?: string;
}

/**
 * 提交邀请码入网：提交瞬间先清空邀请码输入框，绝不把邀请码回显到界面、提示或日志。
 */
export async function submitRelayEnroll(options: {
  input: RelayEnrollInput;
  clearCode: () => void;
  action: (body: DeckTelegramActionBody) => Promise<DeckTelegramStatusResponse>;
}): Promise<RelayEnrollResult> {
  const url = options.input.url.trim();
  const code = options.input.code.trim();
  const name = options.input.name?.trim() ?? "";
  if (url === "" || code === "") {
    return { submitted: false, ok: false };
  }
  // 立即清空邀请码输入，不论后续成功还是失败都不再留在状态中。
  options.clearCode();
  try {
    const body: DeckTelegramActionBody = {
      action: "enroll-relay",
      url,
      code,
      ...(name !== "" ? { name } : {}),
    };
    const status = await options.action(body);
    return { submitted: true, ok: true, status };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    // 防御性避免错误消息意外带出邀请码。
    const sanitized = raw.includes(code) ? raw.replaceAll(code, "***") : raw;
    return { submitted: true, ok: false, error: sanitized };
  }
}

export interface TelegramSectionProps {
  client?: BrowserDaemon;
  initialStatus?: DeckTelegramStatusResponse | null;
  initialEnrolled?: boolean;
}

/** Telegram 桥：Bot Token 或中转、绑定私聊、发送测试。推送「终端会话等你回复」，回复提醒即输入。 */
export function TelegramSection(props: TelegramSectionProps = {}) {
  const daemon = useDaemon();
  const client = props.client ?? daemon.client;
  const { t } = daemon;
  const { push } = useToast();
  const [token, setToken] = useState("");
  const [enrollUrl, setEnrollUrl] = useState(props.initialStatus?.relay?.url ?? "");
  const [enrollCode, setEnrollCode] = useState("");
  const [enrollName, setEnrollName] = useState(props.initialStatus?.relay?.name ?? "");
  const [relayUrl, setRelayUrl] = useState("");
  const [relayKey, setRelayKey] = useState("");
  const [relayName, setRelayName] = useState("");
  const [invite, setInvite] = useState("");
  const [mobileInvite, setMobileInvite] = useState<DeckTelegramEnrollInviteResponse | null>(null);
  const [status, setStatus] = useState<DeckTelegramStatusResponse | null>(props.initialStatus ?? null);
  const [enrolled, setEnrolled] = useState(props.initialEnrolled ?? false);
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await client.deckTelegram();
      setStatus(next);
      setUnsupported(false);
      if (!next.relay) {
        setEnrolled(false);
      } else if (typeof client.dispatchDevices === "function") {
        try {
          const devices = await client.dispatchDevices();
          setEnrolled(devices.enrolled);
        } catch {
          // 旧版 daemon 没有 dispatch 接口时忽略，不影响 Telegram 设置本身。
        }
      }
    } catch {
      setUnsupported(true);
    }
  }, [client]);

  useEffect(() => {
    if (props.initialStatus !== undefined) return;
    void refresh();
  }, [props.initialStatus, refresh]);

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
        if (body.action === "clear-relay") setEnrolled(false);
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

  const handleEnroll = useCallback(async () => {
    setBusy(true);
    try {
      const result = await submitRelayEnroll({
        input: { url: enrollUrl, code: enrollCode, name: enrollName },
        clearCode: () => setEnrollCode(""),
        action: (body) => client.deckTelegramAction(body),
      });
      if (!result.submitted) return;
      if (result.ok && result.status) {
        setStatus(result.status);
        setEnrolled(true);
        push({ message: t("telegramRelayEnrolledOk"), tone: "success" });
      } else if (result.error) {
        push({ message: result.error, tone: "danger" });
      }
    } finally {
      setBusy(false);
    }
  }, [client, enrollCode, enrollName, enrollUrl, push, t]);

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
  const inviteInvalid = invite.trim() !== "" && decodeRelayInvite(invite) === null;

  const pasteInvite = (value: string) => {
    setInvite(value);
    const decoded = decodeRelayInvite(value);
    if (decoded) {
      setRelayUrl(decoded.url);
      setRelayKey(decoded.key);
    }
  };

  const copyInvite = async () => {
    setBusy(true);
    try {
      const { invite: text } = await client.deckTelegramInvite();
      await navigator.clipboard.writeText(text);
      push({ message: t("telegramRelayInviteCopied"), tone: "success" });
    } catch (error) {
      push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const generateMobileInvite = async () => {
    if (typeof client.deckTelegramEnrollInvite !== "function") return;
    setBusy(true);
    try {
      const next = await client.deckTelegramEnrollInvite();
      setMobileInvite(next);
    } catch (error) {
      push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const copyMobilePairing = async () => {
    if (!mobileInvite) return;
    try {
      await navigator.clipboard.writeText(mobileInvite.pairingUri);
      push({ message: t("telegramRelayMobilePairCopied"), tone: "success" });
    } catch (error) {
      push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
    }
  };

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
                  {enrolled ? (
                    <Chip tone="success" dot>
                      {t("telegramRelayEnrolled")}
                    </Chip>
                  ) : null}
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
          {enrolled ? (
            <>
              <div className="notion-token-row">
                <Chip tone="success" dot>
                  {t("telegramRelayEnrolled")}
                </Chip>
                {typeof client.deckTelegramEnrollInvite === "function" ? (
                  <Button size="sm" disabled={busy} onClick={() => void generateMobileInvite()}>
                    {t("telegramRelayMobilePairBtn")}
                  </Button>
                ) : null}
                {relay ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run({ action: "clear-relay" })}>
                    {t("telegramRelayClear")}
                  </Button>
                ) : null}
              </div>
              {mobileInvite ? (
                <div className="dispatch-divider">
                  <span className="notion-label">{t("telegramRelayMobilePairHint")}</span>
                  <div className="notion-status">
                    <code>{mobileInvite.code}</code>
                    <span>{mobileInvite.url}</span>
                  </div>
                  <div className="notion-token-row">
                    <input
                      className="notion-input"
                      type="text"
                      readOnly
                      value={mobileInvite.pairingUri}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <Button size="sm" onClick={() => void copyMobilePairing()}>
                      {t("telegramRelayMobilePairCopy")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <span className="settings-kicker">{t("telegramRelayEnrollTitle")}</span>
              <label className="notion-label" htmlFor="telegram-enroll-url">
                {t("telegramRelayUrl")}
              </label>
              <input
                id="telegram-enroll-url"
                className="notion-input"
                type="url"
                autoComplete="off"
                placeholder="https://relay.example.com"
                value={enrollUrl}
                onChange={(event) => setEnrollUrl(event.target.value)}
              />
              <label className="notion-label" htmlFor="telegram-enroll-code">
                {t("telegramRelayEnrollCode")}
              </label>
              <input
                id="telegram-enroll-code"
                className="notion-input"
                type="password"
                autoComplete="off"
                maxLength={16}
                placeholder={t("telegramRelayEnrollCodePlaceholder")}
                value={enrollCode}
                onChange={(event) => setEnrollCode(event.target.value)}
              />
              <label className="notion-label" htmlFor="telegram-enroll-name">
                {t("telegramRelayName")}
              </label>
              <div className="notion-token-row">
                <input
                  id="telegram-enroll-name"
                  className="notion-input"
                  type="text"
                  autoComplete="off"
                  maxLength={40}
                  value={enrollName}
                  onChange={(event) => setEnrollName(event.target.value)}
                />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || enrollUrl.trim() === "" || enrollCode.trim() === ""}
                  onClick={() => void handleEnroll()}
                >
                  {t("telegramRelayEnrollSubmit")}
                </Button>
              </div>
            </>
          )}

          {relay && !enrolled ? (
            <div className="dispatch-divider">
              <span className="notion-label">{t("telegramRelayLegacyHint")}</span>
              <div className="notion-token-row">
                <Button size="sm" disabled={busy} onClick={() => void copyInvite()}>
                  {t("telegramRelayCopyInvite")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run({ action: "clear-relay" })}>
                  {t("telegramRelayClear")}
                </Button>
              </div>
              <span className="notion-label">{t("telegramRelayInviteHint")}</span>
            </div>
          ) : null}

          {!relay && !enrolled ? (
            <div className="dispatch-divider">
              <span className="settings-kicker">{t("telegramRelayLegacyTitle")}</span>
              <span className="notion-label">{t("telegramRelayLegacyHint")}</span>
              <label className="notion-label" htmlFor="telegram-relay-invite">
                {t("telegramRelayInvite")}
              </label>
              <input
                id="telegram-relay-invite"
                className="notion-input"
                type="password"
                autoComplete="off"
                placeholder="u-brain-relay:…"
                value={invite}
                onChange={(event) => pasteInvite(event.target.value)}
              />
              {inviteInvalid ? <span className="notion-label">{t("telegramRelayInviteInvalid")}</span> : null}
              <span className="notion-label">{t("telegramRelayManual")}</span>
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
                      if (ok) {
                        setRelayKey("");
                        setInvite("");
                      }
                    })
                  }
                >
                  {t("telegramRelaySave")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </Card>
      <Banner tone="info">{t("telegramRelayHint")}</Banner>
      <Banner tone="info">{t("telegramHint")}</Banner>
      {status?.error ? <Banner tone="danger">{status.error}</Banner> : null}
    </Section>
  );
}
