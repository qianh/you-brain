import { useDaemon } from "../../daemon-context.js";
import { Button } from "../../components/button.js";
import { Icon } from "../../components/icons.js";
import { guideSummary, type GuideStep } from "./model.js";

const COPY = {
  drive: { title: "todayGuideDrive", hint: "todayGuideDriveHint", action: "todayGuideDriveAction" },
  model: { title: "todayGuideModel", hint: "todayGuideModelHint", action: "todayGuideModelAction" },
  capture: { title: "todayGuideCapture", hint: "todayGuideCaptureHint", action: "todayGuideCaptureAction" },
} as const;

export function StartGuide({
  steps,
  variant,
  onOpen,
}: {
  steps: readonly GuideStep[];
  variant: "page" | "mini";
  onOpen: (section: GuideStep["section"]) => void;
}) {
  const { t } = useDaemon();
  const progress = guideSummary(steps);
  if (!progress.visible) return null;
  return (
    <section className={variant === "mini" ? "today-guide is-mini" : "today-guide"} aria-label={t("todayGuideTitle")}>
      <header className="today-guide-head">
        <p className="today-guide-name">{t("todayGuideTitle")}</p>
        <span className="today-guide-progress">{t("todayGuideProgress", { done: progress.done, total: progress.total })}</span>
      </header>
      <ol>
        {steps.map((step, index) => {
          const text = COPY[step.id];
          const body = (
            <>
              <span className={step.done ? "today-guide-index is-done" : "today-guide-index"} aria-hidden="true">
                {step.done ? <Icon name="check" size={12} /> : index + 1}
              </span>
              <span className="today-guide-copy">
                <span className="today-guide-label">{t(text.title)}</span>
                <span className="today-guide-hint" title={t(text.hint)}>{t(text.hint)}</span>
              </span>
            </>
          );
          if (variant === "mini") {
            if (step.done) {
              return (
                <li key={step.id} className="is-done">
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
              {step.done ? null : (
                <Button size="sm" variant="secondary" onClick={() => onOpen(step.section)}>
                  {t(text.action)}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
