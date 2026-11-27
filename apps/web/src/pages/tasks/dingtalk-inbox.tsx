import { useState } from "react";
import { dingTalkMinutesUrl, type DingTalkInboxMeeting, type DingTalkInboxView, type TaskActionInput } from "@you-brain/core/tasks/types.js";

import { Banner } from "../../components/banner.js";
import { Button } from "../../components/button.js";
import { Icon } from "../../components/icons.js";
import { useDaemon } from "../../daemon-context.js";
import { formatRelative } from "../../lib/format.js";

type InboxAction = Extract<TaskActionInput, { action: `dingtalk-${string}` }>;
type InboxProps = { busy: boolean; onAction: (input: InboxAction) => Promise<boolean> };

export function DingTalkInbox({ inbox, busy, onAction }: InboxProps & { inbox: DingTalkInboxView }) {
  const { t, language, timeZone } = useDaemon();
  const count = inbox.meetings.reduce((total, meeting) => total + meeting.items.length, 0);
  // 未安装 / 未登录时直接在提示里给出处理按钮，不用让用户去终端找安装命令。
  const setupAction = (code: DingTalkInboxView["errorCode"]) => {
    if (code !== "DINGTALK_NOT_INSTALLED" && code !== "DINGTALK_AUTH_REQUIRED") return undefined;
    const install = code === "DINGTALK_NOT_INSTALLED";
    return <Button size="sm" variant="primary" disabled={busy} icon={<Icon name={install ? "plus" : "key"} size={13} />}
      onClick={() => void onAction({ action: install ? "dingtalk-install" : "dingtalk-login" })}>
      {t(install ? "tasksDingTalkInstall" : "tasksDingTalkLogin")}
    </Button>;
  };
  return <section className="tasks-dingtalk-inbox" aria-label={t("tasksDingTalkInbox")}>
    <header>
      <h2>{t("tasksDingTalkInbox")} <span>{count}</span></h2>
      <div>
        {inbox.lastSyncedAt && <time dateTime={inbox.lastSyncedAt}>{t("tasksDingTalkLastChecked", { when: formatRelative(inbox.lastSyncedAt, language, timeZone) })}</time>}
        <Button size="sm" variant="ghost" loading={inbox.syncing} disabled={busy || inbox.syncing} icon={<Icon name="refresh" size={13} />} onClick={() => void onAction({ action: "dingtalk-sync" })}>{t("tasksDingTalkSyncNow")}</Button>
      </div>
    </header>
    {inbox.setup
      ? <Banner tone="info">
        {t(inbox.setup.step === "install" ? "tasksDingTalkInstalling" : "tasksDingTalkLoggingIn")}
        {inbox.setup.loginUrl && <> <a className="text-link" href={inbox.setup.loginUrl} target="_blank" rel="noreferrer">{t("tasksDingTalkLoginLink")}</a></>}
      </Banner>
      : inbox.error && !inbox.syncing && <Banner tone="warn" action={setupAction(inbox.errorCode)}>{inbox.error}</Banner>}
    {inbox.meetings.length === 0 && !inbox.error && !inbox.syncing && !inbox.setup && <p>{t("tasksDingTalkInboxEmpty")}</p>}
    {inbox.meetings.map((meeting) => <DingTalkMeeting key={meeting.source.taskUuid} meeting={meeting} busy={busy} onAction={onAction} />)}
  </section>;
}

function DingTalkMeeting({ meeting, busy, onAction }: InboxProps & { meeting: DingTalkInboxMeeting }) {
  const { t } = useDaemon();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const { source, items } = meeting;
  const ids = items.filter((item) => selected.has(item.id)).map((item) => item.id);
  const act = async (action: "dingtalk-confirm" | "dingtalk-ignore"): Promise<void> => {
    if (ids.length && await onAction({ action, taskUuid: source.taskUuid, ids })) setSelected(new Set());
  };
  return <details className="tasks-dingtalk-inbox-meeting">
    <summary><span>{source.title}</span><small>{t("tasksCount", { count: items.length })}</small></summary>
    <ul className="tasks-meeting-items">
      {items.map((item) => <li key={item.id}>
        <label><input type="checkbox" checked={selected.has(item.id)} disabled={busy} onChange={(event) => {
          const next = new Set(selected);
          if (event.currentTarget.checked) next.add(item.id);
          else next.delete(item.id);
          setSelected(next);
        }} /><span>{item.description}</span></label>
      </li>)}
    </ul>
    <footer>
      <a className="text-link" href={dingTalkMinutesUrl(source.taskUuid)} target="_blank" rel="noreferrer">{t("tasksDingTalkOpenSource")}</a>
      <div>
        <Button size="sm" variant="ghost" disabled={busy || !ids.length} onClick={() => void act("dingtalk-ignore")}>{t("tasksDingTalkIgnoreSelected")}</Button>
        <Button size="sm" variant="primary" disabled={busy || !ids.length} icon={<Icon name="check" size={13} />} onClick={() => void act("dingtalk-confirm")}>{t("tasksDingTalkQueueSelected", { count: ids.length })}</Button>
      </div>
    </footer>
  </details>;
}
