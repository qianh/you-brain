import type { RelayInviteFile } from "@you-brain/protocol";

import { isLoopbackRelayUrl } from "./relay.js";

/** 云盘里的邀请码剩余不到这么久就换一个新的（心跳 5 分钟一次，这样云盘里始终有可用的）。 */
export const INVITE_REFRESH_BEFORE_MS = 6 * 60_000;

export interface AutoJoinPorts {
  readInvite(): Promise<RelayInviteFile | null>;
  writeInvite(invite: RelayInviteFile): Promise<void>;
  /** 本机的设备 ID，写进云盘文件便于排查。 */
  deviceId(): string;
  /** 本机已入网时用的中转地址；没入网返回 null。 */
  enrolledUrl(): Promise<string | null>;
  /** 向中转要新邀请码（只有已入网的设备能要）。 */
  requestInvite(): Promise<{ url: string; code: string; expiresAt: string }>;
  canJoin(): Promise<boolean>;
  join(url: string, code: string): Promise<void>;
  now(): number;
}

export type AutoJoinResult = "published" | "fresh" | "joined" | "waiting" | "skipped" | "failed";

/**
 * 同一个云盘账号下的设备自动入网。
 * - 已入网：保证云盘里始终有一个没过期的邀请码；
 * - 没入网：读到云盘里的邀请码就兑换，不用人填。
 * 所有失败都吞掉，下一次心跳再试；邀请码是一次性的，同一个码失败过就不再试。
 */
export class RelayAutoJoin {
  readonly #ports: AutoJoinPorts;
  #failedCode: string | null = null;
  /** 上次中转给的对外地址。本机经回环地址连中转时（VPS），云盘里的地址和本机的不一样，靠它判断是不是自己这个中转。 */
  #publishedUrl: string | null = null;
  #running: Promise<AutoJoinResult> | null = null;

  constructor(ports: AutoJoinPorts) {
    this.#ports = ports;
  }

  run(): Promise<AutoJoinResult> {
    if (this.#running) return this.#running;
    const run = this.#run().finally(() => {
      this.#running = null;
    });
    this.#running = run;
    return run;
  }

  async #run(): Promise<AutoJoinResult> {
    try {
      const invite = await this.#ports.readInvite();
      const now = this.#ports.now();
      const url = await this.#ports.enrolledUrl();
      if (url === null) {
        if (!(await this.#ports.canJoin())) return "skipped";
        if (!invite || Date.parse(invite.expiresAt) <= now || invite.code === this.#failedCode) return "waiting";
        // 旧版 VPS 会把回环地址写进云盘，本机去连只会连到自己。
        if (isLoopbackRelayUrl(invite.url)) return "waiting";
        try {
          await this.#ports.join(invite.url, invite.code);
          return "joined";
        } catch {
          this.#failedCode = invite.code;
          return "failed";
        }
      }
      const ours = invite !== null && (invite.url === url || invite.url === this.#publishedUrl);
      if (ours && !isLoopbackRelayUrl(invite.url) && Date.parse(invite.expiresAt) - now > INVITE_REFRESH_BEFORE_MS) return "fresh";
      const fresh = await this.#ports.requestInvite();
      if (isLoopbackRelayUrl(fresh.url)) return "skipped";
      this.#publishedUrl = fresh.url;
      await this.#ports.writeInvite({ url: fresh.url, code: fresh.code, expiresAt: fresh.expiresAt, issuedBy: this.#ports.deviceId() });
      return "published";
    } catch {
      return "failed";
    }
  }
}
