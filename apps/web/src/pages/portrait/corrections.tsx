import { useEffect, useState } from "react";
import type { PortraitCorrectionView } from "@you-brain/core/http/types.js";

import { useDaemon } from "../../daemon-context.js";
import { BrowserDaemonError } from "../../api/client.js";
import { Button } from "../../components/button.js";
import { Chip } from "../../components/chip.js";
import { useToast } from "../../components/toast.js";
import { Field } from "../../components/ui.js";
import { formatDateTime, formatRelative } from "../../lib/format.js";
import type { TocItem } from "../../lib/markdown.js";
import {
  CORRECTION_SECTION_LIMIT,
  CORRECTION_TEXT_LIMIT,
  correctionAllowsForm,
  correctionCanSubmit,
  correctionCount,
  correctionExcerpt,
  correctionHint,
  correctionStatusParts,
} from "./corrections-logic.js";

export function PortraitCorrections({
  variant,
  toc,
}: {
  variant: string;
  toc: readonly TocItem[];
}) {
  const { t, client, language, timeZone, status } = useDaemon();
  const { push } = useToast();
  const allowsForm = correctionAllowsForm(variant);
  const hint = correctionHint(status?.consolidation.enabled === true);
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<PortraitCorrectionView[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    setOpen(false);
  }, [variant]);

  useEffect(() => {
    let alive = true;
    setListError(null);
    void client
      .portraitCorrections(variant)
      .then((body) => {
        if (!alive) return;
        setRows(body.corrections);
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        setRows([]);
        setListError(caught instanceof BrowserDaemonError ? caught.message : t("loadFailed"));
      });
    return () => {
      alive = false;
    };
  }, [client, variant, reloadToken, t]);

  async function submit(): Promise<void> {
    if (!correctionCanSubmit(section, text, saving)) return;
    setSaving(true);
    try {
      await client.addPortraitCorrection({
        variant,
        section: section.trim(),
        text: text.trim(),
      });
      push({ message: t(hint === "on" ? "correctionSaved" : "correctionSavedOff"), tone: "success" });
      setSection("");
      setText("");
      setOpen(false);
      setReloadToken((value) => value + 1);
    } catch (caught: unknown) {
      const message = caught instanceof BrowserDaemonError && caught.message !== "" ? caught.message : t("actionFailed");
      push({ message, tone: "danger" });
    } finally {
      setSaving(false);
    }
  }

  function fillSection(value: string): void {
    setSection(value.trim().slice(0, CORRECTION_SECTION_LIMIT));
  }

  const textOver = correctionCount(text) > CORRECTION_TEXT_LIMIT;

  return (
    <section className="portrait-block portrait-corrections" aria-label={t("correctionTitle")}>
      <p className="portrait-kicker">{t("correctionTitle")}</p>
      <p className="portrait-note">{hint === "on" ? t("correctionHintOn") : t("correctionHintOff")}</p>
      {allowsForm ? null : <p className="portrait-note">{t("correctionFullOnly")}</p>}
      {allowsForm && !open ? (
        <Button className="portrait-copy" variant="secondary" size="sm" onClick={() => setOpen(true)}>
          {t("correctionPropose")}
        </Button>
      ) : null}
      {allowsForm && open ? (
        <form
          className="portrait-correction-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field label={t("correctionSection")} hint={t("correctionSectionHint")}>
            <input
              className="field-control"
              value={section}
              maxLength={CORRECTION_SECTION_LIMIT}
              onChange={(event) => setSection(event.target.value)}
            />
          </Field>
          {toc.length > 0 ? (
            <div className="portrait-correction-picks">
              {toc.map((item) => (
                <button key={item.id} type="button" onClick={() => fillSection(item.text)}>
                  {item.text}
                </button>
              ))}
            </div>
          ) : null}
          <Field
            label={t("correctionText")}
            hint={t("correctionCount", { count: correctionCount(text), limit: CORRECTION_TEXT_LIMIT })}
          >
            <textarea
              className={textOver ? "field-control is-error" : "field-control"}
              value={text}
              rows={4}
              {...(textOver ? { "aria-invalid": true as const } : {})}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <div className="portrait-correction-actions">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={saving}
              disabled={!correctionCanSubmit(section, text, saving)}
            >
              {t("correctionSubmit")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => {
                setOpen(false);
                setSection("");
                setText("");
              }}
            >
              {t("correctionCancel")}
            </Button>
          </div>
        </form>
      ) : null}
      {listError ? <p className="portrait-note">{listError}</p> : null}
      {rows.length === 0 && listError === null ? <p className="portrait-note">{t("correctionEmpty")}</p> : null}
      {rows.length > 0 ? (
        <ul className="portrait-correction-list">
          {rows.map((item) => {
            const parts = correctionStatusParts(item.status, item.snapshot ?? "");
            const shown = expanded.has(item.correctionId) ? { excerpt: item.text, truncated: false } : correctionExcerpt(item.text);
            const clipped = correctionExcerpt(item.text).truncated;
            return (
              <li key={item.correctionId} className="portrait-correction">
                <div className="portrait-correction-head">
                  <span className="portrait-correction-section">{item.section}</span>
                  <Chip tone={parts.key === "applied" ? "success" : "warn"}>
                    {parts.key === "applied"
                      ? parts.version
                        ? `${t("correctionApplied")} ${parts.version}`
                        : t("correctionApplied")
                      : t("correctionPending")}
                  </Chip>
                </div>
                <p className="portrait-correction-text">{shown.excerpt}</p>
                {clipped ? (
                  <button
                    type="button"
                    className="portrait-correction-more"
                    aria-expanded={expanded.has(item.correctionId)}
                    onClick={() => {
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(item.correctionId)) next.delete(item.correctionId);
                        else next.add(item.correctionId);
                        return next;
                      });
                    }}
                  >
                    {expanded.has(item.correctionId) ? t("correctionCollapse") : t("correctionExpand")}
                  </button>
                ) : null}
                <time dateTime={item.createdAt} title={formatDateTime(item.createdAt, language, timeZone)}>
                  {formatRelative(item.createdAt, language, timeZone)}
                </time>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
