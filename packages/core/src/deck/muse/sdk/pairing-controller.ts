// Adapted from Meta's muse-gadget-sdk and wong2/muse-client (Apache-2.0).
import { object, requiredString, type DeviceCredentials } from "./api.js";
import { MuseProtocolError } from "./errors.js";
import { PacketAssembler, PairingSession, encodePackets } from "./pairing-protocol.js";

export interface ControllerOptions {
  session: PairingSession;
  sdkToken?: string | undefined;
  probe?: boolean | undefined;
  online: boolean;
  send: (packets: Buffer[]) => void;
  progress: (message: string) => void;
  verify: (credentials: DeviceCredentials) => Promise<void>;
  save: (credentials: DeviceCredentials) => void;
  complete: (credentials?: DeviceCredentials) => void;
  failed: (error: Error) => void;
}

export class PairingController {
  readonly #assembler = new PacketAssembler();
  #generation = 0;
  #stopped = false;
  #encryptedOnly = false;
  #provisioning = false;

  constructor(private readonly options: ControllerOptions) {}

  disconnect(): void {
    this.#generation++;
    this.#stopped = true;
    this.options.session.reset();
    this.#assembler.reset();
  }

  #send(value: unknown): void {
    this.options.send(encodePackets(Buffer.from(JSON.stringify(value))));
  }

  #status(status: string): void {
    this.#send(
      this.options.session.encrypt({
        type: "status",
        status,
        ...(status === "pairing_confirmed" && this.options.sdkToken
          ? { sdk_token: this.options.sdkToken }
          : {}),
      }),
    );
  }

  async receive(packet: Buffer): Promise<void> {
    if (this.#stopped) return;
    try {
      const raw = this.#assembler.feed(packet);
      if (!raw) return;
      let command = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
      const session = this.options.session;
      let encrypted = false;
      if (command.action === "pairing_encrypted") {
        command = session.decrypt(command);
        encrypted = true;
      }
      const action = command.action;
      if (action === "get_device_info") {
        this.options.progress("手机端已读取设备信息。");
        this.#send({
          type: "device_info",
          ...session.info(),
          node_id: session.identity.nodeId,
          version: session.version,
          build_sha: "",
          network_ready: this.options.online,
        });
        return;
      }
      if (this.options.probe) {
        this.options.progress("蓝牙发现探测成功，已在授权前停止。");
        this.options.complete();
        this.disconnect();
        return;
      }
      if (!encrypted && action === "pairing_client_hello") {
        this.#generation++;
        this.#provisioning = false;
        this.#send(session.hello(command));
        this.#encryptedOnly = true;
        this.options.progress("已建立加密配对握手，请在手机端确认绑定。");
        return;
      }
      if (!encrypted) {
        if (!this.#encryptedOnly) this.options.send([Buffer.from("error_encryption_required")]);
        return;
      }
      if (action === "pairing_client_finished") {
        session.confirm(command);
        this.#status("pairing_confirmed");
        this.options.progress("已收到手机端授权确认，请在手机选择「Use current connection」。");
        return;
      }
      session.assertConfirmed();
      if (action === "wifi_scan") {
        this.#send(
          session.encrypt({
            type: "wifi_scan_result",
            networks: this.options.online ? [{ ssid: "Use current connection", rssi: -40, secure: false }] : [],
          }),
        );
        return;
      }
      if (action !== "provision_v2") {
        this.#status("error_unknown_action");
        return;
      }
      if (this.#provisioning) {
        this.#status("error_operation_in_progress");
        return;
      }
      if (
        command.token_type !== "device" ||
        typeof command.ssid !== "string" ||
        typeof command.password !== "string" ||
        typeof command.access_token !== "string" ||
        !command.access_token ||
        typeof command.refresh_token !== "string" ||
        !command.refresh_token
      ) {
        this.#status("error_missing_credentials");
        return;
      }
      session.provision();
      this.#provisioning = true;
      const generation = this.#generation;
      const credentials: DeviceCredentials = {
        accessToken: requiredString(command.access_token, "device access token"),
        refreshToken: requiredString(command.refresh_token, "device refresh token"),
        deviceId: session.identity.nodeId,
        sdkToken: this.options.sdkToken,
        sdkTokenHint: this.options.sdkToken?.trim().slice(0, 12),
        apiUrl: typeof command.api_url_v2 === "string" ? command.api_url_v2 || undefined : undefined,
        noiseHost: typeof command.noise_host === "string" ? command.noise_host || undefined : undefined,
        savedAt: Math.floor(Date.now() / 1_000),
      };
      this.#status("wifi_connecting");
      if (!this.options.online) {
        this.#status("wifi_failed");
        this.#provisioning = false;
        return;
      }
      this.#status("wifi_connected");
      this.options.progress("正在向 Muse 云端验证设备凭据…");
      try {
        await this.options.verify(credentials);
      } catch {
        if (this.#stopped || generation !== this.#generation) return;
        this.#status("auth_failed");
        throw new MuseProtocolError("Muse 拒绝了设备凭据或无法连接 api.muse.ai（请检查手机与本机网络）");
      }
      if (this.#stopped || generation !== this.#generation) return;
      session.assertConfirmed();
      try {
        this.options.save(credentials);
      } catch {
        this.#status("error_storage");
        throw new MuseProtocolError("无法保存 Muse 配对凭据");
      }
      this.options.progress("配对成功，设备凭据已保存。");
      this.#status("auth_ok");
      this.options.complete(credentials);
      this.disconnect();
    } catch (error) {
      if (this.#stopped) return;
      this.disconnect();
      this.options.failed(error instanceof MuseProtocolError ? error : new MuseProtocolError("配对协议交互失败"));
    }
  }
}
