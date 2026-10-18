export interface SseFrame {
  id: string | null;
  event: string | null;
  data: string;
}

export function drainSse(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer.replaceAll("\r\n", "\n");
  while (true) {
    const split = rest.indexOf("\n\n");
    if (split < 0) break;
    const raw = rest.slice(0, split);
    rest = rest.slice(split + 2);
    const data: string[] = [];
    let id: string | null = null;
    let event: string | null = null;
    for (const line of raw.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const marker = line.indexOf(":");
      const field = marker < 0 ? line : line.slice(0, marker);
      const value = marker < 0 ? "" : line.slice(marker + 1).replace(/^ /u, "");
      if (field === "data") data.push(value);
      else if (field === "event") event = value;
      else if (field === "id") id = value;
    }
    if (data.length === 0) continue;
    frames.push({ id, event, data: data.join("\n") });
  }
  return { frames, rest };
}
