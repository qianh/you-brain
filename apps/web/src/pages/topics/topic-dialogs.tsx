import { useEffect, useState } from "react";
import type { TopicListItem, TopicSessionLink } from "@you-brain/core/http/types.js";

import { Button } from "../../components/button.js";
import { Dialog } from "../../components/dialog.js";
import { Input } from "../../components/input.js";
import { Segmented } from "../../components/segmented.js";
import { Select } from "../../components/select.js";
import { useDaemon } from "../../daemon-context.js";

export function MergeDialog({
  open,
  sourceName,
  sessionCount,
  others,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  sourceName: string;
  sessionCount: number;
  others: readonly TopicListItem[];
  busy: boolean;
  onClose: () => void;
  onConfirm: (intoTopicId: string) => Promise<boolean>;
}) {
  const { t } = useDaemon();
  const [target, setTarget] = useState("");

  useEffect(() => {
    if (open) setTarget("");
  }, [open]);

  const targetName = others.find((topic) => topic.topicId === target)?.name ?? "";
  const impact = targetName
    ? t("mergeImpact", { count: sessionCount, target: targetName })
    : t("mergeImpactPending", { count: sessionCount });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("mergeTitle", { name: sourceName })}
      description={others.length === 0 ? t("mergeEmpty") : impact}
      initialFocus="cancel"
      footer={
        <>
          <Button variant="ghost" data-cancel="" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={target === "" || others.length === 0}
            onClick={() => {
              void onConfirm(target).then((ok) => {
                if (ok) onClose();
              });
            }}
          >
            {t("mergeConfirm")}
          </Button>
        </>
      }
    >
      {others.length > 0 ? (
        <Select
          label={t("chooseTopic")}
          placeholder={t("chooseTopic")}
          value={target}
          searchable
          onChange={setTarget}
          options={others.map((topic) => ({ value: topic.topicId, label: topic.name }))}
        />
      ) : null}
    </Dialog>
  );
}

export function SplitDialog({
  open,
  sourceName,
  session,
  mode,
  others,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  sourceName: string;
  session: TopicSessionLink | null;
  mode: "create" | "assign";
  others: readonly TopicListItem[];
  busy: boolean;
  onClose: () => void;
  onConfirm: (target: { action: "create"; name: string } | { action: "assign"; topicId: string }) => Promise<boolean>;
}) {
  const { t } = useDaemon();
  const [kind, setKind] = useState<"create" | "assign">(mode);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");

  useEffect(() => {
    if (!open) return;
    setKind(mode);
    setName("");
    setTarget("");
  }, [open, mode, session?.sessionKey]);

  const targetName = others.find((topic) => topic.topicId === target)?.name ?? "";
  const trimmed = name.trim();
  const impact = kind === "create"
    ? trimmed === ""
      ? t("splitImpactNeedName", { source: sourceName })
      : t("splitImpactCreate", { source: sourceName, target: trimmed })
    : targetName === ""
      ? t("splitImpactNeedTarget", { source: sourceName })
      : t("splitImpactAssign", { source: sourceName, target: targetName });
  const ready = kind === "create" ? trimmed !== "" : target !== "";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("splitTitle", { name: session?.title.trim() || sourceName })}
      description={impact}
      initialFocus="cancel"
      footer={
        <>
          <Button variant="ghost" data-cancel="" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!ready || (kind === "assign" && others.length === 0)}
            onClick={() => {
              if (!session || !ready) return;
              const next = kind === "create" ? { action: "create" as const, name: trimmed } : { action: "assign" as const, topicId: target };
              void onConfirm(next).then((ok) => {
                if (ok) onClose();
              });
            }}
          >
            {kind === "create" ? t("splitConfirm") : t("moveConfirm")}
          </Button>
        </>
      }
    >
      <div className="topics-split">
        <Segmented
          label={t("splitTitle", { name: sourceName })}
          value={kind}
          options={[
            { value: "create", label: t("newTopic") },
            { value: "assign", label: t("existingTopic"), ...(others.length === 0 ? {} : {}) },
          ]}
          onChange={(value) => {
            if (value === "create" || value === "assign") setKind(value);
          }}
        />
        {kind === "create" ? (
          <Input label={t("topicName")} value={name} placeholder={t("topicName")} onChange={(event) => setName(event.target.value)} />
        ) : others.length === 0 ? (
          <p className="topics-note">{t("mergeEmpty")}</p>
        ) : (
          <Select
            label={t("chooseTopic")}
            placeholder={t("chooseTopic")}
            value={target}
            searchable
            onChange={setTarget}
            options={others.map((topic) => ({ value: topic.topicId, label: topic.name }))}
          />
        )}
      </div>
    </Dialog>
  );
}
