import type { TopicSessionLink } from "@you-brain/core/http/types.js";

import { IconButton } from "../../components/button.js";
import { Section } from "../../components/card.js";
import { Tooltip } from "../../components/tooltip.js";
import { Icon } from "../../components/icons.js";
import { Menu } from "../../components/menu.js";
import { Row } from "../../components/row.js";
import { SourceTile } from "../../components/tile.js";
import { useDaemon } from "../../daemon-context.js";
import { deviceLabel, driveFileUrl, sourceLabel } from "../../lib/format.js";
import { joinMeta } from "./logic.js";
import { RelativeTime } from "./relative-time.js";

export function SessionList({
  sessions,
  others,
  onSplit,
}: {
  sessions: readonly TopicSessionLink[];
  others: number;
  onSplit: (session: TopicSessionLink, mode: "create" | "assign") => void;
}) {
  const { t, devices } = useDaemon();
  return (
    <Section title={t("sessionList")} {...(sessions.length > 0 ? { hint: String(sessions.length) } : {})}>
      {sessions.length === 0 ? (
        <p className="topics-empty-line">{t("noSessions")}</p>
      ) : (
        <div className="topics-sessions">
          {sessions.map((session) => {
            const title = session.title.trim() || t("conversation");
            return (
              <div key={session.sessionKey} className="topics-session">
                <Row
                  icon={<SourceTile source={session.source} size="sm" label={sourceLabel(session.source)} />}
                  title={title}
                  titleText={title}
                  subtitle={joinMeta([sourceLabel(session.source), deviceLabel(session.device, devices), session.summary.trim() || null])}
                  meta={<RelativeTime iso={session.updatedAt} />}
                  trailing={
                    <>
                      {session.fileId ? (
                        <Tooltip content={t("openDrive")}>
                          <a className="icon-btn sm" href={driveFileUrl(session.fileId)} target="_blank" rel="noreferrer" aria-label={t("openDrive")}>
                            <Icon name="external-link" size={14} />
                          </a>
                        </Tooltip>
                      ) : (
                        <span className="topics-muted">{t("noDrive")}</span>
                      )}
                      <Menu
                        label={t("sessionMenu")}
                        trigger={
                          <IconButton label={t("sessionMenu")}>
                            <Icon name="more" />
                          </IconButton>
                        }
                        items={[
                          { id: "create", label: t("splitToNew"), onSelect: () => onSplit(session, "create") },
                          {
                            id: "assign",
                            label: t("moveToOther"),
                            disabled: others === 0,
                            onSelect: () => onSplit(session, "assign"),
                          },
                        ]}
                      />
                    </>
                  }
                />
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
