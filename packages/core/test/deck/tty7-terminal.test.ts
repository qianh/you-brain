import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  openTty7Terminal, terminalFrame, TerminalFrames, tty7SocketPath,
  type TerminalSize, type Tty7TerminalEvents,
} from "../../src/deck/tty7-terminal.js";

const SIZE: TerminalSize = { cols: 100, rows: 30, cell_w: 9, cell_h: 18 };
const json = (kind: number, value: unknown) => terminalFrame(kind, Buffer.from(JSON.stringify(value)));

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("terminal test timed out");
    await Bun.sleep(5);
  }
}

async function fixture(run: (h: {
  path: string;
  inputs: Buffer[];
  sizes: TerminalSize[];
  openings: number[];
  released: () => boolean;
}) => Promise<void>, features = ["size-lease"]) {
  const directory = mkdtempSync(join(tmpdir(), "yb-tty-"));
  const path = join(directory, "test.sock");
  const sockets = new Set<Socket>();
  const inputs: Buffer[] = [];
  const sizes: TerminalSize[] = [];
  const openings: number[] = [];
  let observed: Socket | undefined;
  let released = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    let first = true;
    const decoder = new TerminalFrames();
    socket.on("data", (bytes: Buffer) => decoder.push(bytes, (kind, payload) => {
      if (first) { openings.push(kind); first = false; }
      if (kind === 40) {
        // 真实 tty7 的 Version 请求是一次性的，不能在此连接继续 Observe。
        socket.end(json(40, { protocol: 6, features }));
      } else if (kind === 54) {
        observed = socket;
        socket.write(json(9, SIZE));
        const replay = terminalFrame(2, Buffer.from("\x1b[?1049h\x1b[32m原终端\x1b[0m"));
        // 刻意拆开 header 与 UTF-8 内容。
        for (let n = 0; n < replay.length; n += 3) socket.write(replay.subarray(n, n + 3));
      } else if (kind === 57) {
        const request = JSON.parse(payload.toString());
        sizes.push(request.take.size);
        socket.write(json(9, request.take.size));
      } else if (kind === 55) {
        const [pane, bytes] = JSON.parse(payload.toString());
        const raw = Buffer.from(bytes);
        inputs.push(raw);
        observed?.write(terminalFrame(3, raw));
        socket.end(json(51, pane));
      }
    }));
    socket.on("close", () => {
      sockets.delete(socket);
      if (socket === observed) released = true;
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try { await run({ path, inputs, sizes, openings, released: () => released }); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}

function events(overrides: Partial<Tty7TerminalEvents> = {}): Tty7TerminalEvents {
  return { ready() {}, output() {}, size() {}, lease() {}, warning() {}, exit() {}, error(message) { throw new Error(message); }, close() {}, ...overrides };
}

describe("tty7 real terminal transport", () => {
  it("preserves raw ANSI and fragmented UTF-8, sends every key before Enter and in order", async () => {
    await fixture(async (h) => {
      const output: Buffer[] = [];
      let ready = false;
      const connection = openTty7Terminal({ pane: 17, size: SIZE, socketPath: h.path,
        events: events({ ready() { ready = true; }, output(bytes) { output.push(Buffer.from(bytes)); } }),
      });
      try {
        await until(() => ready && h.sizes.length > 0);
        // 没有 Enter。斜线必须已经进入原 pane，不能留在本地草稿。
        connection.input(Buffer.from("/"));
        await until(() => h.inputs.length === 1);
        expect(h.inputs[0]!.toString()).toBe("/");
        const rest = Buffer.from("\x1b[A\x1b[B\t\x1b[Z\x03\x04\x1b[200~中文\n粘贴\x1b[201~");
        connection.input(rest);
        connection.input(Uint8Array.of(0xff, 0x00, 0x1b));
        await until(() => Buffer.concat(h.inputs).length === 1 + rest.length + 3);
        expect(Buffer.concat(h.inputs)).toEqual(Buffer.concat([Buffer.from("/"), rest, Buffer.from([0xff, 0x00, 0x1b])]));
        await until(() => Buffer.concat(output).includes(rest));
        expect(Buffer.concat(output).includes(Buffer.from("\x1b[?1049h\x1b[32m原终端\x1b[0m"))).toBe(true);
        // 从未 Attach，因此不会顶掉原控制端。
        expect(h.openings).not.toContain(2);
      } finally { connection.close(); }
      await until(h.released);
    });
  });

  it("leases new grid dimensions and releases the observer without killing the pane", async () => {
    await fixture(async (h) => {
      const heard: TerminalSize[] = [];
      const connection = openTty7Terminal({ pane: 5, size: SIZE, socketPath: h.path,
        events: events({ size(size) { heard.push(size); } }),
      });
      await until(() => h.sizes.length > 0);
      const next = { ...SIZE, cols: 123, rows: 45 };
      connection.resize(next);
      await until(() => heard.some((size) => size.cols === 123));
      expect(h.sizes.at(-1)).toEqual(next);
      connection.close();
      await until(h.released);
      expect(h.openings).not.toContain(6);
    });
  });

  it("refuses incompatible daemons before observing or sending any input", async () => {
    await fixture(async (h) => {
      let error = "";
      openTty7Terminal({ pane: 1, size: SIZE, socketPath: h.path, events: events({ error(message) { error = message; } }) });
      await until(() => error !== "");
      expect(error).toContain("size-lease");
      expect(h.openings).toEqual([40]);
    }, []);
  });

  it("rejects oversized frames and matches tty7's long path fallback", () => {
    const frame = Buffer.alloc(5);
    frame.writeUInt32LE(64 * 1024 * 1024 + 1, 0);
    expect(() => new TerminalFrames().push(frame, () => {})).toThrow("过大");
    expect(tty7SocketPath({ TTY7_CONFIG_DIR: "/tmp/tty7" })).toBe("/tmp/tty7/daemon.sock");
    expect(tty7SocketPath({ TTY7_CONFIG_DIR: "/" + "a".repeat(150), XDG_RUNTIME_DIR: "/tmp" })).toMatch(/^\/tmp\/tty7-[a-f0-9]{16}\.sock$/);
  });
});
