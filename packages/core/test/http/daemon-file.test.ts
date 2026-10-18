import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  DaemonFileError,
  createDaemonToken,
  readDaemonEndpoint,
  writeDaemonEndpoint,
} from "../../src/http/daemon-file.js";

function directory(): string {
  return mkdtempSync(join(tmpdir(), "you-brain-daemon-file-"));
}

describe("daemon.json", () => {
  it("writes port, token and pid atomically with mode 600", async () => {
    const dataDir = directory();
    try {
      const token = createDaemonToken();
      const path = await writeDaemonEndpoint(dataDir, {
        port: 4312,
        token,
        pid: process.pid,
      });
      expect(path).toBe(join(dataDir, "daemon.json"));
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        port: 4312,
        token,
        pid: process.pid,
      });
      expect(readdirSync(dataDir)).toEqual(["daemon.json"]);
      expect(await readDaemonEndpoint(dataDir)).toEqual({
        port: 4312,
        token,
        pid: process.pid,
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("returns null when the file is missing and rejects a corrupt file", async () => {
    const dataDir = directory();
    try {
      expect(await readDaemonEndpoint(dataDir)).toBeNull();
      writeFileSync(join(dataDir, "daemon.json"), "{", { mode: 0o600 });
      await expect(readDaemonEndpoint(dataDir)).rejects.toBeInstanceOf(DaemonFileError);
      writeFileSync(join(dataDir, "daemon.json"), JSON.stringify({ port: 1 }), {
        mode: 0o600,
      });
      await expect(readDaemonEndpoint(dataDir)).rejects.toBeInstanceOf(DaemonFileError);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
