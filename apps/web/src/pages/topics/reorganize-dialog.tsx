import { useEffect, useState } from "react";
import type { TopicReorganizePlan } from "@you-brain/core/http/types.js";

import { BrowserDaemonError } from "../../api/client.js";
import { Button } from "../../components/button.js";
import { Dialog } from "../../components/dialog.js";
import { Spinner } from "../../components/spinner.js";
import { useToast } from "../../components/toast.js";
import { useDaemon } from "../../daemon-context.js";
import { selectedGroups, topicsAfter, toggled } from "./reorganize-logic.js";

type Phase =
  | { kind: "planning" }
  | { kind: "ready"; plan: TopicReorganizePlan }
  | { kind: "failed"; message: string };

/**
 * Merging has no undo, so the plan is shown in full and every group can be declined.
 * The daemon holds the plan: it costs minutes of model time, so leaving the page or
 * closing this dialog must not lose it. Reopening picks up the same run.
 */
export function ReorganizeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { client, reload, t } = useDaemon();
  const { push } = useToast();
  const [phase, setPhase] = useState<Phase | null>(null);
  const [declined, setDeclined] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [applying, setApplying] = useState(false);

  const plan = async (refresh: boolean): Promise<void> => {
    setPhase({ kind: "planning" });
    setDeclined(new Set());
    setExpanded(new Set());
    try {
      setPhase({ kind: "ready", plan: await client.planTopicReorganization(refresh ? { refresh } : {}) });
    } catch (caught) {
      const message = caught instanceof BrowserDaemonError ? caught.message : t("reorganizeFailedBody");
      setPhase({ kind: "failed", message });
    }
  };

  useEffect(() => {
    if (open && phase === null) void plan(false);
    // Only opening starts a run. `plan` is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

  const description = ready
    ? ready.groups.length === 0
      ? t("reorganizeNothing")
      : t("reorganizeSummary", { before: ready.topicCount, after: topicsAfter(ready, declined) })
    : phase?.kind === "failed"
      ? t("reorganizeFailedTitle")
      : t("reorganizePlanning");

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
            {phase?.kind === "planning" ? t("reorganizeBackground") : t("cancel")}
          </Button>
          {phase?.kind === "failed" || ready ? (
            <Button disabled={applying} onClick={() => void plan(true)}>
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
      {phase?.kind === "planning" ? (
        <div className="topics-reorganize-wait">
          <Spinner label={t("reorganizePlanning")} />
          <span>{t("reorganizeWait")}</span>
        </div>
      ) : phase?.kind === "failed" ? (
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
