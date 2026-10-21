import type { CapsuleKind } from "../lib/health.js";
import { Spinner } from "./spinner.js";

const CLASS: Record<CapsuleKind, string> = {
  ok: "ok",
  warn: "warn",
  "refine-error": "bad",
  "sync-error": "bad",
  loading: "muted",
  offline: "muted",
};

export function StatusCapsule({
  kind,
  label,
  onClick,
}: {
  kind: CapsuleKind;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button type="button" className={`capsule ${CLASS[kind]}`} onClick={onClick} aria-live="polite">
      {kind === "loading" ? <Spinner /> : <span className="dot" aria-hidden="true" />}
      <span>{label}</span>
    </button>
  );
}
