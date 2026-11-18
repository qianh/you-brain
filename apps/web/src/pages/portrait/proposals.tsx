import { useEffect, useState } from "react";
import type { CodingProposalView } from "@you-brain/core/http/types.js";

import { BrowserDaemonError } from "../../api/client.js";
import { Button } from "../../components/button.js";
import { Chip } from "../../components/chip.js";
import { useToast } from "../../components/toast.js";
import { useDaemon } from "../../daemon-context.js";

export function PortraitProposals({ onApplied }: { onApplied?: () => void }) {
  const { t, client, reload } = useDaemon();
  const { push } = useToast();
  const [rows, setRows] = useState<CodingProposalView[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedLine, setEditedLine] = useState("");

  useEffect(() => {
    let alive = true;
    setListError(null);
    void client
      .portraitProposals()
      .then((body) => {
        if (!alive) return;
        setRows(body.proposals);
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        setRows([]);
        setListError(caught instanceof BrowserDaemonError ? caught.message : t("loadFailed"));
      });
    return () => {
      alive = false;
    };
  }, [client, t]);

  async function act(proposal: CodingProposalView, action: "approve" | "reject"): Promise<void> {
    if (busyId !== null) return;
    const isEditing = editingId === proposal.id;
    const lineOverride = isEditing ? editedLine.trim() : undefined;
    if (action === "approve" && isEditing && (!lineOverride || lineOverride.length > 400)) return;
    setBusyId(proposal.id);
    try {
      const result = await client.reviewPortraitProposal({
        id: proposal.id,
        action,
        ...(action === "approve" && lineOverride !== undefined ? { editedLine: lineOverride } : {}),
      });
      setRows(result.proposals);
      if (isEditing) {
        setEditingId(null);
        setEditedLine("");
      }
      push({
        message: t(action === "approve" ? "proposalApproved" : "proposalRejected"),
        tone: action === "approve" ? "success" : "info",
      });
      if (action === "approve") {
        onApplied?.();
      }
      void reload("status");
    } catch (caught: unknown) {
      const message =
        caught instanceof BrowserDaemonError && caught.message !== "" ? caught.message : t("actionFailed");
      push({ message, tone: "danger" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="portrait-block portrait-corrections" aria-label={t("proposalTitle")}>
      <div className="portrait-kicker-row">
        <p className="portrait-kicker">{t("proposalTitle")}</p>
        <Chip tone={rows.length > 0 ? "warn" : "neutral"}>{rows.length}</Chip>
      </div>
      <p className="portrait-note">{t("proposalHint")}</p>
      {listError ? <p className="portrait-note">{listError}</p> : null}
      {rows.length === 0 && listError === null ? <p className="portrait-note">{t("proposalEmpty")}</p> : null}
      {rows.length > 0 ? (
        <ul className="portrait-correction-list">
          {rows.map((proposal) => {
            const isEditing = editingId === proposal.id;
            const isBusy = busyId === proposal.id;
            return (
              <li key={proposal.id} className="portrait-correction">
                <div className="portrait-correction-head">
                  <span className="portrait-correction-section">{proposal.section.replace(/^##\s+/u, "")}</span>
                  <Chip tone={proposal.action === "replace" ? "warn" : "neutral"}>
                    {t(proposal.action === "replace" ? "proposalActionReplace" : "proposalActionAdd")}
                  </Chip>
                </div>
                {proposal.targetLine ? (
                  <p className="portrait-note">
                    {t("proposalTarget")}
                    {proposal.targetLine}
                  </p>
                ) : null}
                {isEditing ? (
                  <textarea
                    className="field-control"
                    rows={3}
                    maxLength={400}
                    value={editedLine}
                    disabled={isBusy}
                    onChange={(event) => setEditedLine(event.target.value)}
                  />
                ) : (
                  <p className="portrait-correction-text">{proposal.proposedLine}</p>
                )}
                {proposal.reason ? <p className="portrait-note">{proposal.reason}</p> : null}
                <div className="portrait-correction-actions">
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    loading={isBusy}
                    disabled={busyId !== null || (isEditing && editedLine.trim() === "")}
                    onClick={() => {
                      void act(proposal, "approve");
                    }}
                  >
                    {t("proposalApprove")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busyId !== null}
                    onClick={() => {
                      if (isEditing) {
                        setEditingId(null);
                        setEditedLine("");
                      } else {
                        setEditingId(proposal.id);
                        setEditedLine(proposal.proposedLine);
                      }
                    }}
                  >
                    {t(isEditing ? "proposalCancelEdit" : "proposalEdit")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busyId !== null}
                    onClick={() => {
                      void act(proposal, "reject");
                    }}
                  >
                    {t("proposalReject")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
