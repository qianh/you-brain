export interface CodesignInfo {
  identifier: string | null;
  format: string | null;
  signature: string | null;
  authorities: string[];
  teamIdentifier: string | null;
  flags: string | null;
  hardenedRuntime: boolean;
  adHoc: boolean;
}

function field(text: string, label: string): string | null {
  const match = new RegExp(`^${label}=(.*)$`, "mu").exec(text);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/** Parse `codesign -dv --verbose=4` text. That command writes to stderr. */
export function parseCodesignDisplay(text: string): CodesignInfo {
  const authorities = [...text.matchAll(/^Authority=(.*)$/gmu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((value) => value.length > 0);
  const signature = field(text, "Signature");
  const teamIdentifier = field(text, "TeamIdentifier");
  const flags = /^CodeDirectory\b.*\bflags=(\S+)/mu.exec(text)?.[1] ?? null;
  const adHoc =
    signature === "adhoc" ||
    (flags !== null && /adhoc/iu.test(flags)) ||
    (authorities.length === 0 && signature !== null);
  const hardenedRuntime = flags !== null && /runtime/iu.test(flags);
  return {
    identifier: field(text, "Identifier"),
    format: field(text, "Format"),
    signature,
    authorities,
    teamIdentifier,
    flags,
    hardenedRuntime,
    adHoc,
  };
}

export interface SpctlInfo {
  accepted: boolean | null;
  source: string | null;
  detail: string | null;
}

/** Parse `spctl -a -vv` text. Rejection is expected when the app is not notarized. */
export function parseSpctl(text: string): SpctlInfo {
  const accepted = /:\s*accepted\b/iu.test(text) ? true : /:\s*rejected\b/iu.test(text) ? false : null;
  const source = /^source=(.*)$/mu.exec(text)?.[1]?.trim() ?? null;
  const detail = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? null;
  return { accepted, source, detail };
}
