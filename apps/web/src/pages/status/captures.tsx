import { Button } from "../../components/button.js";
import { Card, Section } from "../../components/card.js";
import { Chip } from "../../components/chip.js";
import { EmptyState } from "../../components/empty.js";
import { Icon } from "../../components/icons.js";
import { SourceTile } from "../../components/tile.js";
import { useRelativeTime } from "../../components/use-relative-time.js";
import type { MessageKey } from "../../i18n/messages.js";
import { formatDateTime, sourceLabel, type Language } from "../../lib/format.js";
import { captureTone, type CaptureView, type DotTone } from "./logic.js";

export function CaptureGrid({
  rows,
  language,
  timeZone,
  t,
  onSettings,
}: {
  rows: readonly CaptureView[];
  language: Language;
  timeZone: string;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  onSettings: () => void;
}) {
  return (
    <Section
      title={t("statusSources")}
      actions={
        <Button size="sm" variant="ghost" iconRight={<Icon name="chevron-right" />} onClick={onSettings}>
          {t("statusCaptureSettings")}
        </Button>
      }
    >
      {rows.length === 0 ? (
        <EmptyState icon="inbox" title={t("emptyCaptures")} />
      ) : (
        <div className="status-captures">
          {rows.map((row) => (
            <CaptureCard key={row.source} row={row} language={language} timeZone={timeZone} t={t} />
          ))}
        </div>
      )}
    </Section>
  );
}

function CaptureCard({
  row,
  language,
  timeZone,
  t,
}: {
  row: CaptureView;
  language: Language;
  timeZone: string;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  const relative = useRelativeTime(row.lastCaptureAt, language, timeZone);
  const absolute = formatDateTime(row.lastCaptureAt, language, timeZone);
  const tone = captureTone(row);
  const name = sourceLabel(row.source);
  const state = row.error
    ? row.error
    : row.lastCaptureAt
      ? `${t("statusLastCapture")} ${relative}`
      : t("capturedNever");
  return (
    <Card className="status-capture">
      <div className="status-capture-top">
        <SourceTile source={row.source} label={name} />
        <div className="status-capture-copy">
          <p className="status-capture-name" title={name}>
            {name}
          </p>
          <p className="status-dotline" title={row.lastCaptureAt ? absolute : state}>
            <i className={`dot ${dotClass(tone)}`} aria-hidden="true" />
            <span>{state}</span>
          </p>
        </div>
        <Chip>{row.enabled ? t("statusEnabled") : t("disabledLabel")}</Chip>
      </div>
      {row.count !== null ? <p className="status-capture-count">{t("statusCapturedCount", { count: row.count })}</p> : null}
    </Card>
  );
}

function dotClass(tone: DotTone): string {
  if (tone === "ok") return "dot-ok";
  if (tone === "warn") return "dot-warn";
  if (tone === "bad") return "dot-bad";
  return "dot-muted";
}
