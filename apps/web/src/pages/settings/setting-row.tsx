import { useEffect, useRef, useState, type ReactNode } from "react";

import { Textarea } from "../../components/input.js";
import { Row } from "../../components/row.js";
import { useDaemon } from "../../daemon-context.js";
import { linesToList, listToLines } from "../../lib/copy.js";

export function SettingRow({
  title,
  hint,
  children,
  control = "field",
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  control?: "field" | "select" | "toggle" | "wide";
}) {
  return (
    <Row
      className={`settings-row settings-control-${control}`}
      title={title}
      titleText={title}
      trailing={children}
      {...(hint !== undefined ? { subtitle: hint } : {})}
    />
  );
}

export function ListField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useDaemon();
  const serialized = listToLines(value);
  const [text, setText] = useState(serialized);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(serialized);
  }, [serialized]);
  return (
    <label className="settings-list">
      <span>{label}</span>
      <Textarea
        label={label}
        rows={3}
        value={text}
        spellCheck={false}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          const next = linesToList(text);
          setText(listToLines(next));
          onChange(next);
        }}
        onChange={(event) => {
          const nextText = event.target.value;
          setText(nextText);
          onChange(linesToList(nextText));
        }}
      />
      <small>{t("listHint")}</small>
    </label>
  );
}
