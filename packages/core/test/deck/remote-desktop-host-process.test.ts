import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { ProcessRemoteDesktopPort } from "../../src/deck/remote-desktop/host-process.js";

const FAKE = join(import.meta.dir, "rd-host-fake.ts");

describe("ProcessRemoteDesktopPort", () => {
  test("转发请求与事件；子进程崩溃时通知对端会话关闭，并在下次请求时重启", async () => {
    const port = new ProcessRemoteDesktopPort({
      supported: true,
      getIceServers: () => [{ urls: ["stun:example.com:3478"] }],
      command: [process.execPath, FAKE],
      idleExitMs: 0,
    });
    const ice: string[] = [];
    const states: Array<{ to: string; sessionId: string; state: string; error?: string | undefined }> = [];
    port.setSignalingEvents({
      onIce: (to, sessionId) => ice.push(`${to}:${sessionId}`),
      onState: (to, sessionId, payload) => states.push({ to, sessionId, state: payload.state, error: payload.error }),
    });

    const args = { sessionId: "rd-aaaaaaaa", offerSdp: "v=0", quality: "hd" as const };
    const opened = await port.openSession("peer-1", args);
    expect(opened.sessionId).toBe("rd-aaaaaaaa");
    expect(opened.answerSdp).toBe("ice=1");
    expect(ice).toEqual(["peer-1:rd-aaaaaaaa"]);

    await expect(port.addIceCandidates("peer-1", { sessionId: "rd-aaaaaaaa", candidates: [] })).rejects.toThrow("异常退出");
    expect(states).toEqual([
      { to: "peer-1", sessionId: "rd-aaaaaaaa", state: "closed", error: expect.stringContaining("异常退出") },
    ]);

    const reopened = await port.openSession("peer-2", { ...args, sessionId: "rd-bbbbbbbb" });
    expect(reopened.sessionId).toBe("rd-bbbbbbbb");
    await port.closeSession("peer-2", { sessionId: "rd-bbbbbbbb" });
    await port.closeAll();
  });
});
