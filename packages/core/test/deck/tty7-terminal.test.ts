import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  compactTerminalReplay, openTty7Terminal, terminalFrame, TerminalFrames, tty7SocketPath,
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
  return { ready() {}, live() {}, output() {}, size() {}, lease() {}, warning() {}, exit() {}, error(message) { throw new Error(message); }, close() {}, ...overrides };
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

  it("announces live output once, after the replay and before the first live frame", async () => {
    await fixture(async (h) => {
      const order: string[] = [];
      const connection = openTty7Terminal({ pane: 3, size: SIZE, socketPath: h.path,
        events: events({
          live() { order.push("live"); },
          output(bytes) { order.push(Buffer.from(bytes).toString()); },
        }),
      });
      try {
        await until(() => order.length > 0);
        expect(order).toEqual(["\x1b[?1049h\x1b[32m原终端\x1b[0m"]);
        // fixture 把输入原样作为实时输出（帧 3）回显。
        connection.input(Buffer.from("a"));
        connection.input(Buffer.from("b"));
        await until(() => order.includes("b"));
        expect(order.slice(1)).toEqual(["live", "a", "b"]);
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

  it("coalesces stale Observe size frames when LeaseTake updates the grid during replay", async () => {
    await fixture(async (h) => {
      const fullScreen: TerminalSize = { cols: 320, rows: 78, cell_w: 9, cell_h: 18 };
      const heard: TerminalSize[] = [];
      const connection = openTty7Terminal({
        pane: 9,
        size: fullScreen,
        socketPath: h.path,
        events: events({ size(size) { heard.push(size); } }),
      });
      try {
        await until(() => heard.length > 0);
        // fixture 在 Observe 阶段先发了旧半屏 SIZE (100x30)，紧接着 LeaseTake 发了 320x78；聚合后只应向下游暴露最新的 320x78。
        expect(heard).toEqual([fullScreen]);
      } finally {
        connection.close();
      }
      await until(h.released);
    });
  });

  it("compacts multi-MB alternate-screen TUI replays while keeping DEC modes and final screen", () => {
    const staleRedraws = "\x1b[2J\x1b[H旧画面重绘内容\n".repeat(90_000);
    const raw = Buffer.from(
      `shell prompt % claude\r\n\x1b[?1049h\x1b[?2004h\x1b[?1004h\x1b[?25l${staleRedraws}\x1b[2J\x1b[H最终全屏 TUI 状态栏`,
      "utf8",
    );
    expect(raw.byteLength).toBeGreaterThan(1_500_000);
    const compacted = compactTerminalReplay(raw);
    expect(compacted.byteLength).toBeLessThan(8_192);
    const text = compacted.toString("utf8");
    expect(text).toContain("shell prompt % claude");
    expect(text).toContain("\x1b[?1049h");
    expect(text).toContain("\x1b[?2004h");
    expect(text).toContain("\x1b[?1004h");
    expect(text).toContain("\x1b[?25l");
    expect(text).toContain("最终全屏 TUI 状态栏");
    expect(text).not.toContain("旧画面重绘内容");
  });

  it("truncates oversized normal scrollback cleanly on UTF-8 and line boundaries", () => {
    const line = "这是一行包含多字节中文字符的终端输出日志 0123456789\r\n";
    const raw = Buffer.from(`\x1b[?2004h${line.repeat(12_000)}最后一行完整输出\r\n`, "utf8");
    expect(raw.byteLength).toBeGreaterThan(700_000);
    const compacted = compactTerminalReplay(raw);
    expect(compacted.byteLength).toBeLessThanOrEqual(512 * 1024 + 64);
    const decoded = compacted.toString("utf8");
    expect(decoded).not.toContain("\ufffd");
    expect(decoded).toContain("\x1b[?2004h");
    expect(decoded.endsWith("最后一行完整输出\r\n")).toBe(true);

    // 客户端请求精简尾部回放（如手机端 96 KB）时按指定上限裁剪。
    const mobileCompacted = compactTerminalReplay(raw, 96 * 1024);
    expect(mobileCompacted.byteLength).toBeLessThanOrEqual(96 * 1024 + 64);
    expect(mobileCompacted.toString("utf8").endsWith("最后一行完整输出\r\n")).toBe(true);
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
