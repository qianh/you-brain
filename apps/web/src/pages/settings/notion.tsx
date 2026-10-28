import { useCallback, useEffect, useState } from "react";

import { Banner } from "../../components/banner.js";
import { Button } from "../../components/button.js";
import { Card, Section } from "../../components/card.js";
import { useToast } from "../../components/toast.js";
import { useDaemon } from "../../daemon-context.js";

/** Notion 知识库接入:令牌、连接测试、同步状态。数据只读,编辑回 Notion。 */
export function NotionSection() {
  const { client, t, language } = useDaemon();
  const { push } = useToast();
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<Awaited<ReturnType<typeof client.notionStatus>> | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await client.notionStatus());
    } catch {
      setStatus(null);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async () => {
    const trimmed = token.trim();
    if (trimmed === "") return;
    setBusy(true);
    try {
      await client.putNotionKey({ token: trimmed });
      push({ message: t("knowledgeTokenSaved"), tone: "success" });
      setToken("");
      await refresh();
    } catch (error) {
      push({
        message: error instanceof Error ? error.message : String(error),
        tone: "danger",
      });
    } finally {
      setBusy(false);
    }
  }, [client, push, refresh, t, token]);

  const test = useCallback(async () => {
    setBusy(true);
    try {
      const result = await client.notionTest();
      if (result.ok) {
        push({
          message: t("knowledgeConnectionOk", { name: result.workspaceName ?? result.name ?? "" }),
          tone: "success",
        });
      } else {
        push({ message: result.error ?? "failed", tone: "danger" });
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [client, push, refresh, t]);

  const sync = useCallback(async () => {
    setBusy(true);
    try {
      const summary = await client.notionSync();
      push({
        message: t("knowledgeSyncDone", { pages: summary.pagesSynced, pending: summary.pending }),
        tone: "success",
      });
      await refresh();
    } catch (error) {
      push({
        message: t("knowledgeSyncFailed", { error: error instanceof Error ? error.message : String(error) }),
        tone: "danger",
      });
    } finally {
      setBusy(false);
    }
  }, [client, push, refresh, t]);

  const time = (iso: string | null): string => {
    if (!iso) return "—";
    try {
      return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  };

  return (
    <Section title="Notion">
      <Card>
        <div className="notion-form">
          <label className="notion-label" htmlFor="notion-token">
            {t("knowledgeNotionTokenLabel")}
          </label>
          <div className="notion-token-row">
            <input
              id="notion-token"
              className="notion-input"
              type="password"
              autoComplete="off"
              placeholder={t("knowledgeNotionTokenPlaceholder")}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            <Button size="sm" onClick={() => void save()} disabled={busy || token.trim() === ""}>
              {t("knowledgeNotionSave")}
            </Button>
            {status?.hasToken ? (
              <Button size="sm" variant="ghost" onClick={() => void test()} disabled={busy}>
                {t("knowledgeNotionTest")}
              </Button>
            ) : null}
          </div>
          {status ? (
            <div className="notion-status">
              <span>
                {t("knowledgeNotionPages")}: {status.pages}
              </span>
              <span>
                {t("knowledgeNotionStatus")}: {time(status.lastSyncAt)}
              </span>
              {status.hasToken ? (
                <Button size="sm" variant="ghost" onClick={() => void sync()} disabled={busy || status.syncing}>
                  {status.syncing ? t("knowledgeSyncing") : t("knowledgeSyncNow")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>
      <Banner tone="info">{t("knowledgeShareHint")}</Banner>
      {status?.lastError ? <Banner tone="danger">{status.lastError}</Banner> : null}
    </Section>
  );
}
