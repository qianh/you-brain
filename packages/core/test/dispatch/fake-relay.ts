import type { HelloDispatch } from "@you-brain/protocol";

import type { DispatchRelayFrame, TelegramRelayState } from "../../src/deck/telegram/relay.js";
import type { DispatchHub, DispatchLink } from "../../src/dispatch/index.js";

export interface RelayPeer {
  deviceId: string;
  name: string;
  publicKey: string;
  hub: DispatchHub;
  online: boolean;
  enrolled: boolean;
  dispatch?: HelloDispatch;
}

/** 内存假中转：按协议第 3 节最小规则路由 hello / cmd / result / event。 */
export class FakeRelay {
  readonly peers = new Map<string, RelayPeer>();
  readonly pending = new Map<string, { from: string; to: string }>();
  readonly hellos: Array<{ from: string; dispatch: unknown }> = [];
  readonly sentCmds: Array<{ from: string; to: string; cmdId: string; nonce: string; cmd: unknown }> = [];
  readonly sentResults: Array<{ from: string; cmdId: string; ok: boolean; error?: string }> = [];
  dropCmdCount = 0;
  dropCmdresCount = 0;

  connect(peer: {
    deviceId: string;
    name: string;
    publicKey: string;
    hub: DispatchHub;
    enrolled?: boolean;
  }): DispatchLink {
    const entry: RelayPeer = {
      deviceId: peer.deviceId,
      name: peer.name,
      publicKey: peer.publicKey,
      hub: peer.hub,
      online: true,
      enrolled: peer.enrolled ?? true,
    };
    this.peers.set(peer.deviceId, entry);

    const link: DispatchLink = {
      request: async <T>(op: string, params: Record<string, unknown> = {}): Promise<T> => {
        if (!entry.online) throw new Error("和中转的连接断开了");
        if (op === "hello") {
          entry.dispatch = params.dispatch as HelloDispatch;
          this.hellos.push({ from: entry.deviceId, dispatch: params.dispatch });
          this.broadcastState();
          return { ok: true } as T;
        }
        if (op === "cmd") {
          const to = String(params.to ?? "");
          const cmdId = String(params.cmdId ?? "");
          const nonce = String(params.nonce ?? "");
          const target = this.peers.get(to);
          if (!target || !target.online) throw new Error("目标设备不在线");
          this.sentCmds.push({ from: entry.deviceId, to, cmdId, nonce, cmd: params.cmd });
          this.pending.set(cmdId, { from: entry.deviceId, to });
          if (this.dropCmdCount > 0) {
            this.dropCmdCount -= 1;
            return { accepted: true } as T;
          }
          const frame: DispatchRelayFrame = {
            t: "cmd",
            cmdId,
            from: entry.deviceId,
            to,
            cmd: params.cmd,
            ts: params.ts,
            nonce,
            sig: params.sig,
          };
          queueMicrotask(() => target.hub.onFrame(frame));
          return { accepted: true } as T;
        }
        if (op === "result") {
          const cmdId = String(params.cmdId ?? "");
          const record = this.pending.get(cmdId);
          this.sentResults.push({
            from: entry.deviceId,
            cmdId,
            ok: params.ok === true,
            ...(typeof params.error === "string" ? { error: params.error } : {}),
          });
          if (!record || record.to !== entry.deviceId) throw new Error("无效的 cmdId");
          this.pending.delete(cmdId);
          if (this.dropCmdresCount > 0) {
            this.dropCmdresCount -= 1;
            return {} as T;
          }
          const initiator = this.peers.get(record.from);
          if (initiator && initiator.online) {
            const frame: DispatchRelayFrame =
              params.ok === true
                ? { t: "cmdres", cmdId, from: entry.deviceId, ok: true, result: params.result }
                : { t: "cmdres", cmdId, from: entry.deviceId, ok: false, error: params.error };
            queueMicrotask(() => initiator.hub.onFrame(frame));
          }
          return {} as T;
        }
        if (op === "event") {
          const to = String(params.to ?? "");
          const target = this.peers.get(to);
          if (target && target.online) {
            const frame: DispatchRelayFrame = {
              t: "event",
              from: entry.deviceId,
              dispatchId: params.dispatchId,
              kind: params.kind,
              data: params.data,
            };
            queueMicrotask(() => target.hub.onFrame(frame));
          }
          return {} as T;
        }
        throw new Error(`不支持的操作：${op}`);
      },
    };

    peer.hub.attach(link);
    this.broadcastState();
    return link;
  }

  disconnect(deviceId: string): void {
    const peer = this.peers.get(deviceId);
    if (!peer) return;
    peer.online = false;
    peer.hub.attach(null);
    this.broadcastState();
  }

  broadcastState(): void {
    const state: TelegramRelayState = {
      bot: { username: "ub_bot", name: "UB" },
      bound: { name: "@owner" },
      devices: [...this.peers.values()].map((peer) => ({
        id: peer.deviceId,
        name: peer.name,
        online: peer.online,
        enrolled: peer.enrolled,
        ...(peer.enrolled && peer.publicKey ? { publicKey: peer.publicKey } : {}),
        ...(peer.dispatch ? { dispatch: peer.dispatch } : {}),
      })),
    };
    for (const peer of this.peers.values()) {
      if (peer.online) peer.hub.setState(state);
    }
  }
}
