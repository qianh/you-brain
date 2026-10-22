import type { ReactNode } from "react";
import type { StatusResponse } from "@you-brain/core/http/types.js";

import { Card, Section } from "../../components/card.js";
import { Chip } from "../../components/chip.js";
import { Icon } from "../../components/icons.js";
import { Row } from "../../components/row.js";
import { Tile } from "../../components/tile.js";
import { useRelativeTime } from "../../components/use-relative-time.js";
import type { MessageKey } from "../../i18n/messages.js";
import { consolidationView, type ConsolidationView } from "../../lib/copy.js";
import { formatDateTime, type Language } from "../../lib/format.js";
import { driveTone, refineTone, searchTone, webSessionLine, type DotTone } from "./logic.js";

export function Connections({
  status,
  language,
  timeZone,
  t,
}: {
  status: StatusResponse;
  language: Language;
  timeZone: string;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  const view = consolidationView(status.consolidation);
  const drive = driveLine(status, t);
  const search = status.search.ready
    ? `${t("ready")} · ${t("documents", { count: status.search.documents })}`
    : status.search.documents > 0
      ? `${t("notReady")} · ${t("documents", { count: status.search.documents })}`
      : t("notReady");
  const refineError = (status.refine.lastError ?? "").trim();
  const refine =
    refineError !== ""
      ? refineError
      : status.refine.pending === 0
        ? t("statusRefineIdle")
        : t("statusRefineBusy", { count: status.refine.pending });
  return (
    <Section title={t("statusConnections")}>
      <Card>
        <Row
          icon={<Mark letter="G" />}
          title={t("statusDrive")}
          titleText={t("statusDrive")}
          subtitle={<DotText tone={driveTone(status.drive.reachable)} text={drive} />}
        />
        <Row
          icon={
            <Mark>
              <Icon name="search" />
            </Mark>
          }
          title={t("searchIndex")}
          titleText={t("searchIndex")}
          subtitle={<DotText tone={searchTone(status.search.ready, status.search.documents)} text={search} />}
        />
        <Row
          icon={
            <Mark>
              <Icon name="sparkles" />
            </Mark>
          }
          title={t("groupRefine")}
          titleText={t("groupRefine")}
          subtitle={<DotText tone={refineTone(status.refine.pending, status.refine.lastError)} text={refine} />}
        />
        <WebSessionRow status={status} t={t} />
        <ConsolidationRow
          at={status.consolidation.lastFinishedAt}
          view={view}
          language={language}
          timeZone={timeZone}
          t={t}
        />
      </Card>
    </Section>
  );
}

function ConsolidationRow({
  at,
  view,
  language,
  timeZone,
  t,
}: {
  at: string | null;
  view: ConsolidationView;
  language: Language;
  timeZone: string;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  const relative = useRelativeTime(at, language, timeZone);
  const absolute = formatDateTime(at, language, timeZone);
  const enabled = view !== "disabled" && view !== "unknown";
  const text = !enabled
    ? t("statusConsolidationOff")
    : at
      ? t("statusLastRun", { time: relative })
      : t("consolidationNever");
  const tone: DotTone = view === "stale" ? "warn" : view === "ready" ? "ok" : "muted";
  return (
    <Row
      icon={
        <Mark>
          <Icon name="calendar" />
        </Mark>
      }
      title={t("statusStatDaily")}
      titleText={t("statusStatDaily")}
      subtitle={<DotText tone={tone} text={text} {...(at ? { absolute } : {})} />}
      trailing={
        <Chip tone={view === "stale" ? "warn" : enabled ? "success" : "neutral"}>
          {enabled ? t("statusEnabled") : t("disabledLabel")}
        </Chip>
      }
    />
  );
}

function WebSessionRow({
  status,
  t,
}: {
  status: StatusResponse;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  const line = webSessionLine(status.web);
  if (!line.visible) return null;
  const text = line.kind === "pending" ? t("statusWebPending", { count: line.count }) : t("statusWebDone");
  return (
    <Row
      icon={
        <Mark>
          <Icon name="globe" />
        </Mark>
      }
      title={t("statusWebTitle")}
      titleText={t("statusWebTitle")}
      subtitle={<DotText tone={line.kind === "pending" ? "warn" : "ok"} text={text} />}
    />
  );
}

function driveLine(
  status: StatusResponse,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  if (status.drive.reachable === true) {
    const who = status.drive.accountEmail?.trim() || t("notSignedIn");
    return `${t("statusDriveReachable")} · ${who}`;
  }
  if (status.drive.reachable === false) return t("driveDown");
  return t("driveUnknown");
}

function Mark({ children, letter }: { children?: ReactNode; letter?: string }) {
  return <Tile>{letter ? <span className="tile-letter">{letter}</span> : children}</Tile>;
}

function DotText({ tone, text, absolute = "" }: { tone: DotTone; text: string; absolute?: string }) {
  const dot = tone === "ok" ? "dot-ok" : tone === "warn" ? "dot-warn" : tone === "bad" ? "dot-bad" : "dot-muted";
  return (
    <span className="status-dotline" title={absolute !== "" ? `${text} · ${absolute}` : text}>
      <i className={`dot ${dot}`} aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}
