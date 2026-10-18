export function previewDiff(path: string, before: string | null, after: string | null): string {
  const beforeText = before ?? "";
  const afterText = after ?? "";
  if (beforeText === afterText) return `(unchanged) ${path}`;
  const beforeLines = beforeText === "" ? [] : beforeText.split("\n");
  const afterLines = afterText === "" ? [] : afterText.split("\n");
  let start = 0;
  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  ) {
    start += 1;
  }
  let endBefore = beforeLines.length - 1;
  let endAfter = afterLines.length - 1;
  while (
    endBefore >= start &&
    endAfter >= start &&
    beforeLines[endBefore] === afterLines[endAfter]
  ) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const body: string[] = [];
  for (let index = start; index <= endBefore; index += 1) {
    body.push(`-${beforeLines[index] ?? ""}`);
  }
  for (let index = start; index <= endAfter; index += 1) {
    body.push(`+${afterLines[index] ?? ""}`);
  }
  const from = before === null ? "/dev/null" : path;
  return [`--- ${from}`, `+++ ${path}`, ...body].join("\n");
}
