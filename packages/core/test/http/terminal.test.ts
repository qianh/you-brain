import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import { startDaemonHttp, type DaemonHttpServer } from "../../src/http/server.js";
import type { DeckHttpPort, HttpDeps } from "../../src/http/deps.js";
import type { TerminalSize, Tty7TerminalEvents } from "../../src/deck/tty7-terminal.js";

const SIZE: TerminalSize = { cols: 100, rows: 30, cell_w: 9, cell_h: 18 };
async function withServer(run: (h: {
  server: DaemonHttpServer;
  inputs: Buffer[];
  sizes: TerminalSize[];
  opens: number[];
  closes: () => number;
  events: () => Tty7TerminalEvents;
  flow: { pauses: number; resumes: number };
}) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "yb-terminal-http-"));
  const inputs: Buffer[] = [];
  const sizes: TerminalSize[] = [];
  const opens: number[] = [];
  const flow = { pauses: 0, resumes: 0 };
  let closes = 0;
  let events: Tty7TerminalEvents;
  const deck = { tty7Terminal(pane, size, sink) {
    opens.push(pane);
    sizes.push(size);
    events = sink;
    queueMicrotask(() => { sink.ready(); sink.output(Buffer.from("\x1b[?1049h原终端")); });
    return { input(bytes) { inputs.push(Buffer.from(bytes)); sink.output(bytes); }, resize(next) { sizes.push(next); }, close() { closes++; }, pause() { flow.pauses++; }, resume() { flow.resumes++; } };
  } } as Pick<DeckHttpPort, "tty7Terminal"> as DeckHttpPort;
  const server = await startDaemonHttp({ dataDir: dir, deps: { deck } as HttpDeps });
  try { await run({ server, inputs, sizes, opens, closes: () => closes, events: () => events!, flow }); }
  finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
}

async function connect(server: DaemonHttpServer, token = server.token) {
  const socket = new WebSocket(server.baseUrl.replace("http:", "ws:") + "/api/deck/tty7/terminal", { headers: { origin: server.baseUrl } });
  socket.binaryType = "arraybuffer";
  const messages: Array<string | ArrayBuffer> = [];
  socket.onmessage = (event) => messages.push(event.data);
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("test WebSocket failed")); });
  socket.send(JSON.stringify({ type: "connect", token, pane: 7, size: SIZE }));
  return { socket, messages };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("WebSocket test timed out");
    await Bun.sleep(5);
  }
}

it("rejects cross-origin upgrades and invalid tokens before opening a pane", async () => {
  await withServer(async (h) => {
    const denied = await fetch(h.server.baseUrl + "/api/deck/tty7/terminal", { headers: { origin: "https://untrusted.example" } });
    expect(denied.status).toBe(403);
    const { socket, messages } = await connect(h.server, "invalid-test-token");
    await until(() => socket.readyState === WebSocket.CLOSED);
    expect(messages.some((message) => typeof message === "string" && JSON.parse(message).type === "error")).toBe(true);
    expect(h.opens).toEqual([]);
  });
});

it("bridges raw bytes in both directions over an authenticated WebSocket, with resize and detach", async () => {
  await withServer(async (h) => {
    const { socket, messages } = await connect(h.server);
    await until(() => messages.some((message) => message instanceof ArrayBuffer));
    const replay = messages.find((message) => message instanceof ArrayBuffer) as ArrayBuffer;
    expect(Buffer.from(replay).toString()).toBe("\x1b[?1049h原终端");
    socket.send(JSON.stringify({ type: "ack", bytes: replay.byteLength }));
    const input = Buffer.from([0x2f, 0x1b, 0x5b, 0x41, 0x03, 0xff, 0x00]);
    socket.send(input);
    const next = { ...SIZE, cols: 120, rows: 44 };
    socket.send(JSON.stringify({ type: "resize", size: next }));
    await until(() => h.inputs.length === 1 && h.sizes.length === 2);
    expect(h.inputs[0]).toEqual(input);
    expect(h.sizes[1]).toEqual(next);
    expect(h.opens).toEqual([7]);
    await until(() => messages.filter((message) => message instanceof ArrayBuffer).length === 2);
    expect(Buffer.from(messages.filter((message) => message instanceof ArrayBuffer)[1] as ArrayBuffer)).toEqual(input);
    socket.close();
    await until(() => h.closes() === 1);
  });
});

it("daemon shutdown detaches an open terminal connection", async () => {
  await withServer(async (h) => {
    const { socket, messages } = await connect(h.server);
    await until(() => messages.length > 0);
    await h.server.stop();
    await until(() => socket.readyState === WebSocket.CLOSED);
    expect(h.closes()).toBeGreaterThanOrEqual(1);
  });
});

it("pauses fast output until the browser acknowledges rendering it", async () => {
  await withServer(async (h) => {
    const { socket, messages } = await connect(h.server);
    await until(() => messages.some((message) => message instanceof ArrayBuffer));
    const first = messages.find((message) => message instanceof ArrayBuffer) as ArrayBuffer;
    socket.send(JSON.stringify({ type: "ack", bytes: first.byteLength }));
    await until(() => h.flow.resumes === 1);
    h.events().output(new Uint8Array(300 * 1024));
    expect(h.flow.pauses).toBe(1);
    await until(() => messages.filter((message) => message instanceof ArrayBuffer).length === 2);
    expect(h.flow.resumes).toBe(1);
    socket.send(JSON.stringify({ type: "ack", bytes: 300 * 1024 }));
    await until(() => h.flow.resumes === 2);
    socket.close();
  });
});
