import { Icon } from "../../components/icons.js";
import { Spinner } from "../../components/spinner.js";
import type { HeroKind } from "./logic.js";

export function StatusHero({
  tone,
  title,
  body,
  syncLabel,
  syncValue,
  syncIso,
  syncAbsolute,
  syncFault = null,
}: {
  tone: HeroKind;
  title: string;
  body: string;
  syncLabel: string;
  syncValue: string;
  syncIso: string | null;
  syncAbsolute: string;
  syncFault?: string | null;
}) {
  return (
    <section className={`status-hero tone-${tone}`} aria-live="polite">
      <span className="status-hero-badge" aria-hidden="true">
        {tone === "loading" ? (
          <Spinner label={title} />
        ) : (
          <Icon name={tone === "ok" ? "check" : tone === "warn" ? "alert" : "x"} size={20} />
        )}
      </span>
      <div className="status-hero-copy">
        <h2>{title}</h2>
        <p>{body}</p>
      </div>
      <div className="status-hero-sync">
        <span>{syncLabel}</span>
        {syncFault ? <strong className="status-sync-fault">{syncFault}</strong> : null}
        {syncIso ? <time dateTime={syncIso} title={syncAbsolute}>{syncValue}</time> : syncFault ? null : <strong>{syncValue}</strong>}
      </div>
    </section>
  );
}

