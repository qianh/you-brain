import { useEffect, useRef, useState } from "react";

import { Section } from "../../components/card.js";
import { Tooltip } from "../../components/tooltip.js";
import { Chip } from "../../components/chip.js";
import { Icon } from "../../components/icons.js";
import { Input } from "../../components/input.js";
import { useDaemon } from "../../daemon-context.js";
import { nextAliases } from "./logic.js";

export function AliasList({
  topicId,
  aliases,
  busy,
  onChange,
}: {
  topicId: string;
  aliases: readonly string[];
  busy: boolean;
  onChange: (aliases: string[], change: { type: "add" | "remove"; name: string }) => Promise<boolean>;
}) {
  const { t } = useDaemon();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const addingRef = useRef(false);
  const skip = useRef(false);

  useEffect(() => {
    addingRef.current = false;
    setAdding(false);
    setDraft("");
  }, [topicId]);

  const commit = (): void => {
    if (skip.current) {
      skip.current = false;
      return;
    }
    if (!addingRef.current) return;
    addingRef.current = false;
    const next = nextAliases(aliases, { type: "add", name: draft });
    setAdding(false);
    setDraft("");
    if (!next) return;
    const name = draft.trim();
    void onChange(next, { type: "add", name });
  };

  const remove = (name: string): void => {
    const next = nextAliases(aliases, { type: "remove", name });
    if (!next) return;
    void onChange(next, { type: "remove", name });
  };

  return (
    <Section title={t("aliases")}>
      <div className="topics-aliases">
        {aliases.map((alias) => (
          <span key={alias} className="chip">
            <span>{alias}</span>
            <Tooltip content={t("removeAlias", { name: alias })}>
              <button type="button" className="topics-alias-x" aria-label={t("removeAlias", { name: alias })} disabled={busy} onClick={() => remove(alias)}>
                <Icon name="x" size={12} />
              </button>
            </Tooltip>
          </span>
        ))}
        {adding ? (
          <Input
            label={t("addAlias")}
            value={draft}
            placeholder={t("aliasPlaceholder")}
            autoFocus
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                skip.current = true;
                setAdding(false);
                setDraft("");
              }
            }}
          />
        ) : (
          <Chip
            icon={<Icon name="plus" size={12} />}
            disabled={busy}
            onClick={() => {
              addingRef.current = true;
              setAdding(true);
            }}
          >
            {t("addAlias")}
          </Chip>
        )}
      </div>
    </Section>
  );
}
