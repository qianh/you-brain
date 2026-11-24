// 远程桌面宿主子进程替身：open 返回应答并推送一条 ICE 事件；ice 请求时模拟崩溃。
const decoder = new TextDecoder();
let buffer = "";
const write = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line.trim()) continue;
    const req = JSON.parse(line) as { id: number; method: string; params: { from: string; args: { sessionId: string }; iceServers?: unknown[] } };
    if (req.method === "open") {
      write({ ev: "ice", to: req.params.from, sessionId: req.params.args.sessionId, candidates: [{ candidate: "" }] });
      write({
        id: req.id,
        ok: true,
        result: {
          sessionId: req.params.args.sessionId,
          answerSdp: `ice=${req.params.iceServers?.length ?? 0}`,
          displays: [],
          activeDisplayId: 0,
          permissions: { screenRecording: true, accessibility: true },
        },
      });
    } else if (req.method === "ice") {
      process.exit(3);
    } else if (req.method === "shutdown") {
      write({ id: req.id, ok: true, result: { ok: true } });
      process.exit(0);
    } else {
      write({ id: req.id, ok: true, result: { ok: true } });
    }
  }
}
