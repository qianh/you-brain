import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LossBasedBitrateController } from "../../src/deck/remote-desktop/bitrate.js";
import {
  HostFileTransfer,
  RemoteDownloadSink,
  sanitizeFileName,
  type FileChannelPort,
} from "../../src/deck/remote-desktop/file-transfer.js";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rd-transfer-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

class FakePort implements FileChannelPort {
  sent: Array<string | Buffer> = [];
  bufferedAmount = 0;
  isOpen = true;
  send(data: string | Buffer): void {
    this.sent.push(typeof data === "string" ? data : Buffer.from(data));
  }
  async waitDrain(): Promise<void> {}
  json(): Array<Record<string, unknown>> {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
}

describe("LossBasedBitrateController", () => {
  test("丢包乘性降、干净链路缓慢回升", () => {
    const changes: number[] = [];
    const ctl = new LossBasedBitrateController({ maxBps: 10_000_000, onChange: (bps) => changes.push(bps) });
    ctl.onReceiverReport(64, 0); // 25% 丢包
    expect(ctl.targetBps).toBe(7_000_000);
    ctl.onReceiverReport(64, 100); // 间隔内不再降
    expect(ctl.targetBps).toBe(7_000_000);
    ctl.onReceiverReport(13, 400); // ~5% 轻度丢包
    expect(ctl.targetBps).toBe(6_160_000);
    ctl.onReceiverReport(0, 1000); // 降后 3 秒内不加
    expect(ctl.targetBps).toBe(6_160_000);
    ctl.onReceiverReport(0, 3500);
    expect(ctl.targetBps).toBe(Math.round(6_160_000 * 1.08));
    expect(changes.length).toBe(3);
    for (let t = 0; t < 200; t += 1) ctl.onReceiverReport(255, 4000 + t * 400);
    expect(ctl.targetBps).toBe(2_000_000); // 下限为上限的 20%
    ctl.setMax(5_000_000);
    expect(ctl.targetBps).toBe(5_000_000);
  });
});

describe("HostFileTransfer", () => {
  test("sanitizeFileName 去掉路径与控制字符", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("a\u0000b:c.txt")).toBe("a_b_c.txt");
    expect(sanitizeFileName("...")).toBe("file");
    expect(sanitizeFileName("..\\..\\x.txt")).toBe("x.txt");
  });

  test("上传写入下载目录，重名自动加序号；大小不符则删除", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "a.txt"), "old");
    const port = new FakePort();
    const transfer = new HostFileTransfer(port, { downloadsDir: dir, isDownloadAllowed: () => false });
    transfer.handleMessage(JSON.stringify({ t: "put", id: "u1", name: "a.txt", size: 5 }));
    transfer.handleMessage(Buffer.from("hel"));
    transfer.handleMessage(Buffer.from("lo"));
    transfer.handleMessage(JSON.stringify({ t: "end", id: "u1" }));
    await waitFor(() => port.json().some((m) => m.t === "saved"));
    const saved = port.json().find((m) => m.t === "saved")!;
    expect(saved.name).toBe("a (1).txt");
    expect(await readFile(join(dir, "a (1).txt"), "utf8")).toBe("hello");

    transfer.handleMessage(JSON.stringify({ t: "put", id: "u2", name: "b.txt", size: 10 }));
    transfer.handleMessage(Buffer.from("abc"));
    transfer.handleMessage(JSON.stringify({ t: "end", id: "u2" }));
    await waitFor(() => port.json().some((m) => m.t === "error" && m.id === "u2"));
    expect((await readdir(dir)).sort()).toEqual(["a (1).txt", "a.txt"]);
    await transfer.dispose();
  });

  test("下载只允许通告过的文件，并按 meta → 分片 → done 发送", async () => {
    const dir = await tempDir();
    const file = join(dir, "c.bin");
    await writeFile(file, Buffer.alloc(40_000, 7));
    const port = new FakePort();
    const transfer = new HostFileTransfer(port, { downloadsDir: dir, isDownloadAllowed: (p) => p === file });
    transfer.handleMessage(JSON.stringify({ t: "get", id: "d0", path: "/etc/hosts" }));
    await waitFor(() => port.json().some((m) => m.id === "d0"));
    expect(port.json().find((m) => m.id === "d0")!.t).toBe("error");

    transfer.handleMessage(JSON.stringify({ t: "get", id: "d1", path: file }));
    await waitFor(() => port.json().some((m) => m.t === "done"));
    expect(port.json().find((m) => m.t === "meta")).toMatchObject({ id: "d1", name: "c.bin", size: 40_000 });
    const bytes = port.sent.filter((s): s is Buffer => typeof s !== "string");
    expect(bytes.reduce((n, b) => n + b.length, 0)).toBe(40_000);
    expect(Math.max(...bytes.map((b) => b.length))).toBeLessThanOrEqual(16 * 1024);
    await transfer.dispose();
  });

  test("dest=clipboard 的上传收在内存并写入剪贴板，不落盘", async () => {
    const dir = await tempDir();
    const port = new FakePort();
    const written: Buffer[] = [];
    const transfer = new HostFileTransfer(port, {
      downloadsDir: dir,
      isDownloadAllowed: () => false,
      writeClipboardImage: (data) => {
        written.push(data);
      },
    });
    const png = Buffer.alloc(20_000, 3);
    transfer.handleMessage(JSON.stringify({ t: "put", id: "c1", name: "shot.png", size: png.length, dest: "clipboard" }));
    transfer.handleMessage(png.subarray(0, 16_384));
    transfer.handleMessage(png.subarray(16_384));
    transfer.handleMessage(JSON.stringify({ t: "end", id: "c1" }));
    await waitFor(() => port.json().some((m) => m.t === "saved"));
    expect(port.json().find((m) => m.t === "saved")).toMatchObject({ id: "c1", path: "clipboard" });
    expect(written).toHaveLength(1);
    expect(written[0]!.equals(png)).toBe(true);
    expect(await readdir(dir)).toEqual([]);

    transfer.handleMessage(JSON.stringify({ t: "put", id: "c2", name: "big.png", size: 21 * 1024 * 1024, dest: "clipboard" }));
    await waitFor(() => port.json().some((m) => m.id === "c2"));
    expect(port.json().find((m) => m.id === "c2")!.t).toBe("error");
    await transfer.dispose();
  });

  test("clipboard:image 虚拟路径下载宿主剪贴板图片；没有图片时报错", async () => {
    const dir = await tempDir();
    const port = new FakePort();
    let image: Buffer | null = Buffer.alloc(30_000, 5);
    const transfer = new HostFileTransfer(port, {
      downloadsDir: dir,
      isDownloadAllowed: () => false,
      readClipboardImage: async () => image,
    });
    transfer.handleMessage(JSON.stringify({ t: "get", id: "g1", path: "clipboard:image" }));
    await waitFor(() => port.json().some((m) => m.t === "done"));
    expect(port.json().find((m) => m.t === "meta")).toMatchObject({ id: "g1", name: "clipboard.png", size: 30_000 });
    const bytes = port.sent.filter((s): s is Buffer => typeof s !== "string");
    expect(Buffer.concat(bytes).equals(image)).toBe(true);

    image = null;
    transfer.handleMessage(JSON.stringify({ t: "get", id: "g2", path: "clipboard:image" }));
    await waitFor(() => port.json().some((m) => m.id === "g2"));
    expect(port.json().find((m) => m.id === "g2")!.t).toBe("error");
    await transfer.dispose();
  });
});

describe("RemoteDownloadSink", () => {
  test("按偏移顺序追加写入，顺序错误时报错并清理", async () => {
    const dir = await tempDir();
    const sink = new RemoteDownloadSink({ downloadsDir: dir });
    await sink.append({ token: "t1", name: "x.txt", offset: 0, bytes: Buffer.from("ab"), final: false });
    const done = await sink.append({ token: "t1", name: "x.txt", offset: 2, bytes: Buffer.from("cd"), final: true });
    expect(done).toMatchObject({ name: "x.txt", size: 4 });
    expect(await readFile(done.path, "utf8")).toBe("abcd");

    await sink.append({ token: "t2", name: "y.txt", offset: 0, bytes: Buffer.from("ab"), final: false });
    await expect(sink.append({ token: "t2", name: "y.txt", offset: 5, bytes: Buffer.from("z"), final: true })).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["x.txt"]);
    await expect(sink.append({ token: "../bad", name: "z", offset: 0, bytes: Buffer.from(""), final: true })).rejects.toThrow();
  });
});
