import { useEffect, useState } from "react";
import type { TopicReorganizePlan, TopicReorganizeStatus } from "@you-brain/core/http/types.js";

import { BrowserDaemonError } from "../../api/client.js";
import { Button } from "../../components/button.js";
import { Dialog } from "../../components/dialog.js";
import { Spinner } from "../../components/spinner.js";
import { useToast } from "../../components/toast.js";
import { useDaemon } from "../../daemon-context.js";
import { formatElapsed, selectedGroups, topicsAfter, toggled, watchReorganize } from "./reorganize-logic.js";

type Phase =
  | { kind: "planning"; state: "queued" | "running"; startedAt: string }
  | { kind: "ready"; plan: TopicReorganizePlan }
  | { kind: "failed"; message: string };

function WaitingNote({ startedAt }: { startedAt: string }) {
  const { t } = useDaemon();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span>
      {t("reorganizeElapsed", { time: formatElapsed(now - Date.parse(startedAt)) })}
      {t("reorganizeWait")}
    </span>
  );
}

/**
 * Merging has no undo, so the plan is shown in full and every group can be declined.
 * The daemon owns the run: it costs minutes of model time, so leaving the page or
 * closing this dialog must not lose it. This dialog only asks the daemon how it is going.
 */
export function ReorganizeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { client, reload, t } = useDaemon();
  const { push } = useToast();
  // Null while the first answer from the daemon is on its way.
  const [phase, setPhase] = useState<Phase | null>(null);
  const [declined, setDeclined] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [applying, setApplying] = useState(false);

  const show = (status: TopicReorganizeStatus): void => {
    if (status.state === "ready") setPhase({ kind: "ready", plan: status.plan });
    else if (status.state === "failed") setPhase({ kind: "failed", message: status.message });
    else if (status.state === "idle") setPhase({ kind: "failed", message: t("reorganizeLost") });
    else setPhase({ kind: "planning", state: status.state, startedAt: status.startedAt });
  };
  const showError = (caught: unknown): void => {
    const message = caught instanceof BrowserDaemonError ? caught.message : t("reorganizeFailedBody");
    setPhase({ kind: "failed", message });
  };

  const regenerate = async (): Promise<void> => {
    setPhase(null);
    setDeclined(new Set());
    setExpanded(new Set());
    try {
      show(await client.planTopicReorganization({ refresh: true }));
    } catch (caught) {
      showError(caught);
    }
  };

  // Opening reports whatever the daemon has: a run in progress, a finished plan, or a
  // failure that happened while this was closed. Only an idle daemon starts a new run.
  useEffect(() => {
    if (!open || phase?.kind === "ready") return;
    let stale = false;
    void (async () => {
      try {
        const current = await client.topicReorganizeStatus();
        const status = current.state === "idle" ? await client.planTopicReorganization() : current;
        if (!stale) show(status);
      } catch (caught) {
        if (!stale) showError(caught);
      }
    })();
    return () => {
      stale = true;
    };
    // Only opening asks. `show` and `showError` are rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const watching = open && phase?.kind === "planning";
  useEffect(() => {
    if (!watching) return;
    return watchReorganize({
      read: () => client.topicReorganizeStatus(),
      onStatus: show,
      onLost: () => setPhase({ kind: "failed", message: t("reorganizeUnreachable") }),
    });
    // Restarted only when watching starts or stops, not on each status.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching]);

  const ready = phase?.kind === "ready" ? phase.plan : null;
  const chosen = ready ? selectedGroups(ready, declined) : [];

  const apply = async (): Promise<void> => {
    if (!ready || chosen.length === 0) return;
    setApplying(true);
    try {
      const { merged } = await client.applyTopicReorganization({
        groups: chosen.map((group) => ({
          intoTopicId: group.intoTopicId,
          fromTopicIds: group.members.slice(1).map((member) => member.topicId),
          name: group.name,
          archive: group.archive,
        })),
      });
      await reload("topics");
      setPhase(null);
      onClose();
      push({ message: t("reorganizeDone", { count: merged }), tone: "success" });
    } catch {
      push({ message: t("reorganizeApplyFailed"), tone: "danger" });
    } finally {
      setApplying(false);
    }
  };

  const waitingLabel =
    phase?.kind === "planning" && phase.state === "queued" ? t("reorganizeQueued") : t("reorganizePlanning");
  const description = ready
    ? ready.groups.length === 0
      ? t("reorganizeNothing")
      : t("reorganizeSummary", { before: ready.topicCount, after: topicsAfter(ready, declined) })
    : phase?.kind === "failed"
      ? t("reorganizeFailedTitle")
      : waitingLabel;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("reorganizeTitle")}
      description={description}
      size="lg"
      initialFocus="cancel"
      footer={
        <>
          <Button variant="ghost" data-cancel="" onClick={onClose}>
            {phase === null || phase.kind === "planning" ? t("reorganizeBackground") : t("cancel")}
          </Button>
          {phase?.kind === "failed" || ready ? (
            <Button disabled={applying} onClick={() => void regenerate()}>
              {t("reorganizeAgain")}
            </Button>
          ) : null}
          {ready && ready.groups.length > 0 ? (
            <Button variant="primary" loading={applying} disabled={chosen.length === 0} onClick={() => void apply()}>
              {t("reorganizeApply", { count: chosen.length })}
            </Button>
          ) : null}
        </>
      }
    >
      {phase === null || phase.kind === "planning" ? (
        <div className="topics-reorganize-wait">
          <Spinner label={waitingLabel} />
          {phase === null ? <span>{t("reorganizeWait")}</span> : <WaitingNote startedAt={phase.startedAt} />}
        </div>
      ) : phase.kind === "failed" ? (
        <p className="topics-note">{phase.message}</p>
      ) : ready && ready.groups.length > 0 ? (
        <>
          {ready.reviewedCount < ready.topicCount ? (
            <p className="topics-note">{t("reorganizePartial", { count: ready.reviewedCount })}</p>
          ) : null}
          <ul className="topics-reorganize-list">
            {ready.groups.map((group) => {
              const on = !declined.has(group.intoTopicId);
              const open = expanded.has(group.intoTopicId);
              const sessions = group.members.reduce((sum, member) => sum + member.sessionCount, 0);
              return (
                <li key={group.intoTopicId} className={on ? "topics-reorganize-item" : "topics-reorganize-item is-off"}>
                  <label className="topics-reorganize-head">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={applying}
                      onChange={() => setDeclined((current) => toggled(current, group.intoTopicId))}
                    />
                    <span className="topics-reorganize-name">{group.name}</span>
                    <span className="topics-muted">
                      {t(group.archive ? "reorganizeArchiveCount" : "reorganizeMergeCount", {
                        count: group.members.length,
                        sessions,
                      })}
                    </span>
                  </label>
                  {group.reason !== "" ? <p className="topics-reorganize-reason">{group.reason}</p> : null}
                  <button
                    type="button"
                    className="topics-reorganize-toggle"
                    aria-expanded={open}
                    onClick={() => setExpanded((current) => toggled(current, group.intoTopicId))}
                  >
                    {open ? t("reorganizeHide") : t("reorganizeShow")}
                  </button>
                  {open ? (
                    <ul className="topics-reorganize-members">
                      {group.members.map((member) => (
                        <li key={member.topicId}>
                          {member.name}
                          <span className="topics-muted"> · {t("topicSessionCount", { count: member.sessionCount })}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </Dialog>
  );
}
