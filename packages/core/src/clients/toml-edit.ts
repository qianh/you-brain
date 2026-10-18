function sectionHeader(line: string): string | undefined {
  const match = /^\[([^\]]+)\][ \t]*$/u.exec(line);
  return match?.[1];
}

export function tomlSectionMatches(header: string, table: string, name: string): boolean {
  const prefixes = [
    `${table}.${name}`,
    `${table}."${name}"`,
    `${table}.'${name}'`,
  ];
  return prefixes.some(
    (prefix) => header === prefix || header.startsWith(`${prefix}.`),
  );
}

export function renderTomlMcpServer(options: {
  table?: string;
  name: string;
  command: string;
  args: readonly string[];
}): string {
  const table = options.table ?? "mcp_servers";
  const args = options.args.map((arg) => JSON.stringify(arg)).join(", ");
  return `[${table}.${options.name}]\ncommand = ${JSON.stringify(options.command)}\nargs = [${args}]\n`;
}

export function upsertTomlSection(
  source: string,
  table: string,
  name: string,
  replacement: string,
): string {
  return editTomlSection(source, table, name, replacement.trimEnd());
}

export function removeTomlSection(source: string, table: string, name: string): string {
  return editTomlSection(source, table, name, null);
}

export function tomlHasSection(source: string, table: string, name: string): boolean {
  return source.split("\n").some((line) => {
    const header = sectionHeader(line);
    return header !== undefined && tomlSectionMatches(header, table, name);
  });
}

function editTomlSection(
  source: string,
  table: string,
  name: string,
  replacement: string | null,
): string {
  const hadTrailingNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (lines.at(-1) === "" && source.endsWith("\n")) lines.pop();
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = sectionHeader(lines[index] ?? "");
    if (!header || !tomlSectionMatches(header, table, name)) continue;
    let end = index + 1;
    while (end < lines.length && sectionHeader(lines[end] ?? "") === undefined) {
      if ((lines[end] ?? "").startsWith("[")) break;
      end += 1;
    }
    ranges.push({ start: index, end });
  }
  let next = lines;
  for (const range of [...ranges].reverse()) {
    let start = range.start;
    if (start > 0 && (next[start - 1] ?? "").trim() === "") start -= 1;
    next = [...next.slice(0, start), ...next.slice(range.end)];
  }
  if (replacement !== null) {
    while (next.length > 0 && (next.at(-1) ?? "").trim() === "") next.pop();
    if (next.length > 0) next.push("");
    next.push(...replacement.split("\n"));
  }
  while (next.length > 0 && (next.at(-1) ?? "").trim() === "" && replacement === null) {
    next.pop();
  }
  if (next.length === 0) return replacement === null ? "" : `${replacement}\n`;
  const text = next.join("\n");
  if (hadTrailingNewline || replacement !== null || source.endsWith("\n")) {
    return text.endsWith("\n") ? text : `${text}\n`;
  }
  return text;
}
