import { useState } from "react";

import { useDaemon } from "../../daemon-context.js";
import { Button } from "../../components/button.js";
import { Icon } from "../../components/icons.js";
import { foldGuideSteps, guideCopy, guideSummary, joinGuideNames, type GuideStep } from "./model.js";

export function StartGuide({
  steps,
  variant,
  onOpen,
}: {
  steps: readonly GuideStep[];
  variant: "page" | "mini";
  onOpen: (section: GuideStep["section"]) => void;
}) {
  const { t, language } = useDaemon();
  const progress = guideSummary(steps);
  const fold = foldGuideSteps(steps);
  const [doneOpen, setDoneOpen] = useState(false);
  if (!progress.visible) return null;

  const renderStep = (step: GuideStep) => {
    const index = steps.findIndex((item) => item.id === step.id);
    const copy = guideCopy(step);
    const body = (
      <>
        <span className={step.done ? "today-guide-index is-done" : "today-guide-index"} aria-hidden="true">
          {step.done ? <Icon name="check" size={12} /> : index + 1}
        </span>
        <span className="today-guide-copy">
          <span className="today-guide-label">{t(copy.title)}</span>
          <span className="today-guide-hint" title={t(copy.hint, copy.vars)}>{t(copy.hint, copy.vars)}</span>
        </span>
      </>
    );
    if (variant === "mini") {
      // A step with no action (checking, connected, done) is only a row, not a button.
      if (copy.action === null) {
        return (
          <li key={step.id} className={step.done ? "is-done" : undefined}>
            <div className="today-guide-row">{body}</div>
          </li>
        );
      }
      return (
        <li key={step.id}>
          <button type="button" className="today-guide-row" onClick={() => onOpen(step.section)}>
            {body}
            <Icon name="chevron-right" />
          </button>
        </li>
      );
    }
    return (
      <li key={step.id} className={step.done ? "is-done" : ""}>
        {body}
        {copy.action === null ? null : (
          <Button size="sm" variant="secondary" onClick={() => onOpen(step.section)}>
            {t(copy.action)}
          </Button>
        )}
      </li>
    );
  };

  const names = joinGuideNames(
    fold.done.map((step) => t(step.id === "drive" ? "panelGuideDrive" : step.id === "model" ? "panelGuideModel" : "panelGuideCapture")),
    language === "en" ? ", " : "、",
  );
  const listed = variant === "mini" && fold.collapsed ? (
    <>
      <li>
        <button
          type="button"
          className="today-guide-summary"
          aria-expanded={doneOpen}
          onClick={() => setDoneOpen((open) => !open)}
        >
          <span className="today-guide-summary-text">
            {t("panelGuideDone", { done: progress.done, total: progress.total, names })}
          </span>
          <Icon name={doneOpen ? "chevron-up" : "chevron-down"} />
        </button>
      </li>
      {doneOpen ? fold.done.map((step) => renderStep(step)) : null}
      {fold.pending.map((step) => renderStep(step))}
    </>
  ) : (
    steps.map((step) => renderStep(step))
  );

  return (
    <section className={variant === "mini" ? "today-guide is-mini" : "today-guide"} aria-label={t("todayGuideTitle")}>
      <header className="today-guide-head">
        <p className="today-guide-name">{t("todayGuideTitle")}</p>
        <span className="today-guide-progress">{t("todayGuideProgress", { done: progress.done, total: progress.total })}</span>
      </header>
      <ol>{listed}</ol>
    </section>
  );
}
