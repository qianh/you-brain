import { useEffect, useRef, useState } from "react";

import { Section } from "../../components/card.js";
import { Tooltip } from "../../components/tooltip.js";
import { Chip } from "../../components/chip.js";
import { Icon } from "../../components/icons.js";
import { Input } from "../../components/input.js";
import { Spinner } from "../../components/spinner.js";
import { useToast } from "../../components/toast.js";
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
  const { push } = useToast();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  /** Which change is in flight, so the row it belongs to can show it. */
  const [saving, setSaving] = useState<
    { type: "add" } | { type: "remove"; name: string } | null
  >(null);
  const addingRef = useRef(false);
  const skip = useRef(false);

  useEffect(() => {
    addingRef.current = false;
    setAdding(false);
    setDraft("");
    setSaving(null);
  }, [topicId]);

  const commit = (): void => {
    if (skip.current) {
      skip.current = false;
      return;
    }
    if (!addingRef.current) return;
    addingRef.current = false;
    const name = draft.trim();
    const next = nextAliases(aliases, { type: "add", name: draft });
    if (!next) {
      // Clearing the input without a word looked like the click was ignored: the alias
      // was either empty or already on the list.
      setAdding(false);
      setDraft("");
      if (name !== "" && aliases.includes(name)) {
        push({ message: t("aliasExists", { name }), tone: "warn" });
      }
      return;
    }
    // Keep the input on screen showing the pending name until the change lands: the row
    // is optimistic, so without this the only evidence of the request is the delay.
    setDraft(name);
    setSaving({ type: "add" });
    void onChange(next, { type: "add", name }).then((ok) => {
      setSaving(null);
      setAdding(false);
      setDraft("");
      if (!ok) setAdding(true);
    });
  };

  const remove = (name: string): void => {
    const next = nextAliases(aliases, { type: "remove", name });
    if (!next) return;
    setSaving({ type: "remove", name });
    void onChange(next, { type: "remove", name }).then(() => setSaving(null));
  };

  return (
    <Section title={t("aliases")}>
      <div className="topics-aliases">
        {aliases.map((alias) => (
          <span key={alias} className="chip">
            <span>{alias}</span>
            <Tooltip content={t("removeAlias", { name: alias })}>
              <button
                type="button"
                className={
                  saving?.type === "remove" && saving.name === alias
                    ? "topics-alias-x is-pending"
                    : "topics-alias-x"
                }
                aria-label={t("removeAlias", { name: alias })}
                aria-busy={(saving?.type === "remove" && saving.name === alias) || undefined}
                disabled={busy || saving !== null}
                onClick={() => remove(alias)}
              >
                {saving?.type === "remove" && saving.name === alias ? (
                  <Spinner />
                ) : (
                  <Icon name="x" size={12} />
                )}
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
            disabled={busy || saving?.type === "add"}
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
            loading={saving?.type === "add"}
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
