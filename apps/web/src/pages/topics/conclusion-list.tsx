import { useEffect, useState } from "react";
import type { ConclusionView, TopicSessionLink } from "@you-brain/core/http/types.js";

import { Button } from "../../components/button.js";
import { Section } from "../../components/card.js";
import { Icon } from "../../components/icons.js";
import { Textarea } from "../../components/input.js";
import { Kbd } from "../../components/kbd.js";
import { Select } from "../../components/select.js";
import { useDaemon } from "../../daemon-context.js";
import { formatDateTime } from "../../lib/format.js";
import { modLabel, shortcutMod } from "../../lib/shortcuts.js";
import { sortConclusions } from "./logic.js";

export function ConclusionList({
  topicId,
  conclusions,
  sessions,
  busy,
  onAdd,
}: {
  topicId: string;
  conclusions: readonly ConclusionView[];
  sessions: readonly TopicSessionLink[];
  busy: boolean;
  onAdd: (text: string, sessionKey: string) => Promise<boolean>;
}) {
  const { t, language, timeZone } = useDaemon();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sessionKey, setSessionKey] = useState(sessions[0]?.sessionKey ?? "");
  const sorted = sortConclusions(conclusions);
  const chord = modLabel(shortcutMod(typeof navigator === "undefined" ? "" : navigator.platform));

  useEffect(() => {
    setOpen(false);
    setText("");
  }, [topicId]);

  useEffect(() => {
    setSessionKey((current) => (current !== "" && sessions.some((session) => session.sessionKey === current) ? current : sessions[0]?.sessionKey ?? ""));
  }, [topicId, sessions]);

  const submit = (): void => {
    const body = text.trim();
    if (body === "" || sessionKey === "" || busy) return;
    void onAdd(body, sessionKey).then((ok) => {
      if (ok) {
        setText("");
        setOpen(false);
      }
    });
  };

  return (
    <Section
      title={t("conclusions")}
      {...(sorted.length > 0 ? { hint: String(sorted.length) } : {})}
      actions={
        <Button size="sm" icon={<Icon name="plus" size={14} />} aria-expanded={open} disabled={sessions.length === 0} onClick={() => setOpen((value) => !value)}>
          {t("addConclusion")}
        </Button>
      }
    >
      {sorted.length === 0 ? <p className="topics-empty-line">{t("noConclusions")}</p> : null}
      {sorted.length > 0 ? (
        <ol className="topics-timeline">
          {sorted.map((item) => (
            <li key={item.conclusionId} className="topics-conclusion">
              <i className="topics-conclusion-dot" aria-hidden="true" />
              <p>{item.text}</p>
              <time dateTime={item.ts} title={formatDateTime(item.ts, language, timeZone)}>
                {formatDateTime(item.ts, language, timeZone)}
              </time>
            </li>
          ))}
        </ol>
      ) : null}
      {sessions.length === 0 ? <p className="topics-note">{t("conclusionNeedSession")}</p> : null}
      {open && sessions.length > 0 ? (
        <div className="topics-form">
          <Select
            label={t("sessionForConclusion")}
            value={sessionKey}
            onChange={setSessionKey}
            options={sessions.map((session) => ({
              value: session.sessionKey,
              label: session.title.trim() || t("conversation"),
            }))}
          />
          <Textarea
            label={t("conclusionPlaceholder")}
            value={text}
            rows={3}
            placeholder={t("conclusionPlaceholder")}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="topics-form-actions">
            <span className="topics-hint">
              <Kbd>{chord}</Kbd>
              <Kbd>Enter</Kbd>
              <span>{t("submitHint")}</span>
            </span>
            <Button size="sm" variant="primary" loading={busy} disabled={text.trim() === "" || sessionKey === ""} onClick={submit}>
              {t("conclusionAdd")}
            </Button>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
