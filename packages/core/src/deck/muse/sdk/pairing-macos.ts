// Adapted from wong2/muse-client macOS CoreBluetooth transport (Apache-2.0).
// Swift source and Info.plist are embedded inline so `bun build --compile` works without external asset files.
// Launches `U-Brain Muse Pair.app` via LaunchServices (`open -W -n --args --socket ...`) over a private 0700 Unix
// domain socket so macOS TCC attributes Bluetooth permission to `U-Brain Muse Pair.app` independently of parent process.
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect as connectTCP, createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { MuseAccount, object, requiredString, type DeviceCredentials } from "./api.js";
import { MuseError } from "./errors.js";
import { PairingController } from "./pairing-controller.js";
import { PairingSession, identityFromMac, newIdentity } from "./pairing-protocol.js";

const exec = promisify(execFile);

const PAIRING_HELPER_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>MusePair</string>
  <key>CFBundleIdentifier</key><string>app.you-brain.muse-pair</string>
  <key>CFBundleName</key><string>U-Brain Muse Pair</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>NSBluetoothAlwaysUsageDescription</key><string>允许手机 Muse App 发现当前 Mac 并完成授权绑定。</string>
  <key>NSBluetoothPeripheralUsageDescription</key><string>在配对期间将当前 Mac 广播为 Muse 设备。</string>
</dict></plist>
`;

const PAIRING_HELPER_SWIFT = `import AppKit
import CoreBluetooth
import Darwin

func connectUnixSocket(_ path: String) -> Int32 {
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return -1 }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let utf8 = Array(path.utf8)
    let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
    guard utf8.count < maxLen else { Darwin.close(fd); return -1 }
    withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
        ptr.withMemoryRebound(to: UInt8.self, capacity: maxLen) { dst in
            dst.initialize(repeating: 0, count: maxLen)
            for (i, byte) in utf8.enumerated() { dst[i] = byte }
        }
    }
    let len = socklen_t(MemoryLayout<sockaddr_un>.size)
    let rc = withUnsafePointer(to: &addr) { ptr in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
            Darwin.connect(fd, sa, len)
        }
    }
    guard rc == 0 else { Darwin.close(fd); return -1 }
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    return fd
}

final class PairingHelper: NSObject, NSApplicationDelegate, CBPeripheralManagerDelegate {
    let serviceID = CBUUID(string: "7fdd3d1c-38ea-46cf-8b46-314ecf5f240c")
    let rxID = CBUUID(string: "4d593029-28a2-4a6e-a1f0-3c2d5e8f9b01")
    let txID = CBUUID(string: "d75dc4ca-7b2b-4e9c-8f0a-1d2e3f4a5b6c")
    var readFD: Int32 = STDIN_FILENO
    var writeFD: Int32 = STDOUT_FILENO
    var ownsSocket = false
    let writeLock = NSLock()
    var manager: CBPeripheralManager?
    var tx: CBMutableCharacteristic?
    var central: CBCentral?
    var pending: [Data] = []
    var lastValue = Data()
    var name = ""
    var sending = false
    var stopping = false
    var completed = false
    var completionScheduled = false
    var statusItem: NSStatusItem!

    func configureIPC() -> Bool {
        let args = CommandLine.arguments
        if let idx = args.firstIndex(of: "--socket"), idx + 1 < args.count {
            let fd = connectUnixSocket(args[idx + 1])
            if fd < 0 { return false }
            readFD = fd
            writeFD = fd
            ownsSocket = true
        }
        return true
    }

    func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        let line = data + Data([10])
        writeLock.lock()
        defer { writeLock.unlock() }
        guard writeFD >= 0 else { return }
        line.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            var offset = 0
            while offset < line.count {
                let written = Darwin.write(writeFD, base.advanced(by: offset), line.count - offset)
                if written <= 0 { break }
                offset += written
            }
        }
    }
    func fail(_ message: String) { emit(["event": "error", "message": message]); quit() }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if !configureIPC() {
            NSApplication.shared.terminate(nil)
            return
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "Muse Pair"
        let menu = NSMenu()
        menu.addItem(withTitle: "Quit Muse Pair", action: #selector(quit), keyEquivalent: "q").target = self
        statusItem.menu = menu
        let fd = readFD
        DispatchQueue.global().async {
            var buffer = Data()
            var scratch = [UInt8](repeating: 0, count: 4096)
            while true {
                let n = Darwin.read(fd, &scratch, scratch.count)
                if n <= 0 {
                    DispatchQueue.main.async { self.quit() }
                    return
                }
                buffer.append(contentsOf: scratch[0..<n])
                if buffer.count > 262144 {
                    DispatchQueue.main.async { self.fail("IPC input exceeded size limit") }; return
                }
                while let newline = buffer.firstIndex(of: 10) {
                    let line = Data(buffer[..<newline]); buffer.removeSubrange(...newline)
                    guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                        DispatchQueue.main.async { self.fail("Invalid IPC message") }; return
                    }
                    DispatchQueue.main.async { self.handle(object) }
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 660) { self.fail("蓝牙配对已超时") }
        emit(["event": "ready"])
    }

    func handle(_ event: [String: Any]) {
        guard !stopping else { return }
        switch event["event"] as? String {
        case "start":
            guard manager == nil, let requestedName = event["name"] as? String,
                  requestedName.range(of: "^MuseGadget[0-9A-F]{6}$", options: .regularExpression) != nil else {
                fail("Invalid device name or duplicate start"); return
            }
            name = requestedName
            manager = CBPeripheralManager(delegate: self, queue: .main)
        case "packets":
            guard let encoded = event["packets"] as? [String] else { fail("Invalid notification list"); return }
            for item in encoded {
                guard let packet = Data(base64Encoded: item), packet.count <= 20 else { fail("Invalid notification packet"); return }
                pending.append(packet)
            }
            if pending.count > 2048 { fail("Notification queue exceeded size limit"); return }
            flush()
        case "complete": completed = true; flush(); finishIfDrained()
        case "stop": quit()
        default: fail("Unknown IPC command")
        }
    }

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        emit(["event": "bluetooth", "state": peripheral.state.rawValue, "authorization": CBManager.authorization.rawValue])
        guard peripheral.state == .poweredOn else {
            if peripheral.state == .unauthorized || CBManager.authorization == .denied || CBManager.authorization == .restricted {
                fail("蓝牙权限被拒绝，请在「系统设置 > 隐私与安全性 > 蓝牙」中允许 U-Brain（或 U-Brain Muse Pair）。")
            } else if peripheral.state == .unsupported {
                fail("当前设备不支持蓝牙外设模式")
            } else if central != nil {
                fail("蓝牙在配对过程中不可用")
            }
            return
        }
        peripheral.removeAllServices()
        let service = CBMutableService(type: serviceID, primary: true)
        let rx = CBMutableCharacteristic(type: rxID, properties: [.write, .writeWithoutResponse], value: nil, permissions: [.writeable])
        let notify = CBMutableCharacteristic(type: txID, properties: [.read, .notify], value: nil, permissions: [.readable])
        tx = notify; service.characteristics = [rx, notify]
        peripheral.add(service)
    }
    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error { fail("GATT 注册失败: \\(error.localizedDescription)"); return }
        peripheral.startAdvertising([CBAdvertisementDataLocalNameKey: name])
    }
    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let error { fail("蓝牙广播启动失败: \\(error.localizedDescription)"); return }
        emit(["event": "advertising", "name": name])
    }
    func peripheralManager(_ peripheral: CBPeripheralManager, central peer: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        guard central == nil || central?.identifier == peer.identifier else { return }
        central = peer; emit(["event": "subscribed"]); flush()
    }
    func peripheralManager(_ peripheral: CBPeripheralManager, central peer: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        guard central?.identifier == peer.identifier else { return }
        if !completed { emit(["event": "disconnected"]) }
        quit()
    }
    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        guard let first = requests.first else { return }
        guard !completed, requests.allSatisfy({ $0.characteristic.uuid == rxID && $0.offset == 0 && $0.value != nil &&
            $0.central.identifier == first.central.identifier && (central == nil || central?.identifier == $0.central.identifier) }) else {
            peripheral.respond(to: first, withResult: .writeNotPermitted); return
        }
        central = first.central
        for request in requests { emit(["event": "write", "data": request.value!.base64EncodedString()]) }
        peripheral.respond(to: first, withResult: .success)
    }
    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        guard request.characteristic.uuid == txID, central == nil || central?.identifier == request.central.identifier else {
            peripheral.respond(to: request, withResult: .readNotPermitted); return
        }
        guard request.offset <= lastValue.count else { peripheral.respond(to: request, withResult: .invalidOffset); return }
        request.value = lastValue.subdata(in: request.offset..<lastValue.count)
        peripheral.respond(to: request, withResult: .success)
    }
    func flush() {
        guard !stopping, !sending, !pending.isEmpty, let central, let tx, let manager,
              tx.subscribedCentrals?.contains(where: { $0.identifier == central.identifier }) == true else { finishIfDrained(); return }
        if manager.updateValue(pending[0], for: tx, onSubscribedCentrals: [central]) {
            lastValue = pending.removeFirst(); sending = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.sending = false; self.flush() }
        }
    }
    func finishIfDrained() {
        if completed && pending.isEmpty && !sending && !completionScheduled {
            completionScheduled = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.quit() }
        }
    }
    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) { flush() }
    @objc func quit() {
        guard !stopping else { return }
        stopping = true
        manager?.stopAdvertising()
        manager?.removeAllServices()
        emit(["event": "stopped", "completed": completed])
        writeLock.lock()
        if ownsSocket && writeFD >= 0 {
            Darwin.close(writeFD)
            writeFD = -1
            readFD = -1
        }
        writeLock.unlock()
        NSApplication.shared.terminate(nil)
    }
    func applicationWillTerminate(_ notification: Notification) { manager?.stopAdvertising() }
}

let app = NSApplication.shared
let delegate = PairingHelper()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
`;

export interface PairProgressEvent {
  phase: "compiling" | "advertising" | "connected" | "verifying";
  deviceName?: string | undefined;
  message: string;
}

export interface PairMacOSOptions {
  directory: string;
  sdkToken?: string | undefined;
  probe?: boolean | undefined;
  signal?: AbortSignal | undefined;
  homeDir?: string | undefined;
  onProgress?: ((event: PairProgressEvent) => void) | undefined;
}

export function validateSDKToken(token: string): string {
  const value = token.trim();
  if (!/^mgst_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)) {
    throw new MuseError("SDK Token 格式不正确（应以 mgst_ 开头，可在 gadgets.muse.ai 获取）");
  }
  return value;
}

/** Build and cache `U-Brain Muse Pair.app`, returning the `.app` bundle path. */
export async function buildPairingHelper(
  home = homedir(),
  onProgress: (message: string) => void = () => {},
): Promise<string> {
  if (process.platform !== "darwin") {
    throw new MuseError("蓝牙配对目前仅支持在 macOS 上直接进行");
  }
  const digest = createHash("sha256")
    .update(PAIRING_HELPER_SWIFT)
    .update(PAIRING_HELPER_PLIST)
    .update(process.arch)
    .digest("hex")
    .slice(0, 20);
  const cache = join(home, "Library", "Caches", "you-brain", "muse-bluetooth");
  const destination = join(cache, digest);
  const appBundle = join(destination, "U-Brain Muse Pair.app");
  const executable = join(appBundle, "Contents", "MacOS", "MusePair");
  try {
    await access(executable);
    return appBundle;
  } catch {
    // Compile on first use.
  }
  onProgress("正在编译 macOS 蓝牙配对助手（首次约需数秒）…");
  const moduleCache = join(cache, "module-cache");
  await mkdir(moduleCache, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(cache, "build-"));
  const swiftPath = join(temporary, "PairingHelper.swift");
  const app = join(temporary, "U-Brain Muse Pair.app");
  try {
    await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
    await writeFile(swiftPath, PAIRING_HELPER_SWIFT, "utf8");
    await writeFile(join(app, "Contents", "Info.plist"), PAIRING_HELPER_PLIST, "utf8");
    await exec(
      "xcrun",
      [
        "swiftc",
        "-module-cache-path",
        moduleCache,
        "-swift-version",
        "5",
        swiftPath,
        "-o",
        join(app, "Contents", "MacOS", "MusePair"),
        "-framework",
        "AppKit",
        "-framework",
        "CoreBluetooth",
      ],
      { timeout: 120_000 },
    );
    await rm(swiftPath, { force: true });
    await exec("codesign", ["--force", "--sign", "-", app], { timeout: 15_000 });
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!existsSync(executable)) throw error;
    }
    return appBundle;
  } catch {
    throw new MuseError("无法编译 macOS 蓝牙助手，请确认已安装 Xcode Command Line Tools（xcode-select --install）。");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function writePrivate(path: string, data: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

async function checkOnline(): Promise<boolean> {
  return new Promise((resolveDone) => {
    const socket = connectTCP({ host: "api.muse.ai", port: 443 });
    const finish = (ok: boolean): void => {
      socket.destroy();
      resolveDone(ok);
    };
    socket.setTimeout(5_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function pairMacOS(options: PairMacOSOptions): Promise<DeviceCredentials | undefined> {
  if (process.platform !== "darwin") {
    throw new MuseError("蓝牙配对目前仅支持在 macOS 上直接进行");
  }
  options.signal?.throwIfAborted();
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!options.probe && existsSync(join(directory, "pairing.json"))) {
    throw new MuseError("当前已配对 Muse；如需重新绑定，请先点击「解除配对」。");
  }
  let sdkToken: string | undefined;
  if (!options.probe) {
    const candidate = options.sdkToken?.trim() || (await readFile(join(directory, "sdk_token"), "utf8").catch(() => ""));
    sdkToken = validateSDKToken(candidate);
  }
  const lockPath = join(directory, "pair.lock");
  let lock: number;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch {
    throw new MuseError("已有配对流程正在运行，请稍候或先取消当前配对。");
  }
  // Keep Unix socket path short (< 104 bytes on macOS) inside a private 0700 directory.
  const sockDir = join("/tmp", `yb-mp-${randomUUID().slice(0, 12)}`);
  await mkdir(sockDir, { recursive: true, mode: 0o700 });
  const sockPath = join(sockDir, "s");
  try {
    writeFileSync(lock, String(process.pid));
    let identity;
    try {
      identity = identityFromMac(
        requiredString(object(JSON.parse(await readFile(join(directory, "identity.json"), "utf8"))).mac, "identity MAC"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      identity = newIdentity();
      writePrivate(join(directory, "identity.json"), JSON.stringify({ mac: identity.mac }, null, 2));
    }
    if (sdkToken) writePrivate(join(directory, "sdk_token"), `${sdkToken}\n`);

    const report = (phase: PairProgressEvent["phase"], message: string): void => {
      options.onProgress?.({ phase, deviceName: identity.name, message });
    };

    const appBundle = await buildPairingHelper(options.homeDir ?? homedir(), (msg) => report("compiling", msg));
    options.signal?.throwIfAborted();
    const networkReady = await checkOnline();
    if (!networkReady && !options.probe) {
      throw new MuseError("本机无法访问 api.muse.ai，请检查网络连接或代理设置后重试。");
    }
    options.signal?.throwIfAborted();
    report("advertising", `准备广播 ${identity.name}，请在手机打开 Muse App 添加设备。`);

    return await new Promise<DeviceCredentials | undefined>((resolveResult, reject) => {
      let finished = false;
      let completed = false;
      let phase: PairProgressEvent["phase"] = "advertising";
      let credentials: DeviceCredentials | undefined;
      let ipcSocket: Socket | null = null;
      let buffer = "";
      let stderrTail = "";

      const send = (event: unknown): void => {
        if (!finished && ipcSocket && !ipcSocket.destroyed) {
          ipcSocket.write(`${JSON.stringify(event)}\n`);
        }
      };

      const server = createServer((conn) => {
        if (ipcSocket) {
          conn.destroy();
          return;
        }
        ipcSocket = conn;
        conn.setEncoding("utf8");
        conn.on("data", (data: string) => {
          if (finished) return;
          buffer += data;
          if (buffer.length > 262_144) {
            finish(new MuseError("蓝牙配对助手输出超出上限"));
            return;
          }
          let offset: number;
          while ((offset = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, offset);
            buffer = buffer.slice(offset + 1);
            try {
              const event = object(JSON.parse(line));
              switch (event.event) {
                case "ready":
                  report(
                    "advertising",
                    `正在请求蓝牙外设权限（如系统弹出「U-Brain Muse Pair 想要使用蓝牙」，请点击「允许」）…`,
                  );
                  send({ event: "start", name: identity.name });
                  break;
                case "advertising":
                  phase = "advertising";
                  report("advertising", `正在通过蓝牙广播 ${identity.name}，请在手机 Muse App 中选择该设备。`);
                  break;
                case "subscribed":
                  phase = "connected";
                  report("connected", "手机已通过蓝牙连接，正在协商加密会话…");
                  break;
                case "bluetooth":
                  if (event.state === 4) {
                    report("advertising", "本机蓝牙未开启，请在 macOS 系统设置中打开蓝牙。");
                  }
                  break;
                case "write":
                  void controller.receive(Buffer.from(requiredString(event.data, "BLE packet"), "base64"));
                  break;
                case "disconnected":
                  if (!completed) finish(new MuseError("手机蓝牙连接已断开，请重试。"));
                  break;
                case "error":
                  finish(new MuseError(requiredString(event.message, "helper error")));
                  break;
                case "stopped":
                  break;
              }
            } catch {
              finish(new MuseError("蓝牙配对助手返回了无效消息"));
            }
          }
        });
        conn.on("close", () => {
          if (!finished) {
            finish(
              completed
                ? undefined
                : new MuseError(
                    stderrTail.trim()
                      ? `蓝牙配对助手异常退出：${stderrTail.trim().slice(0, 200)}`
                      : "蓝牙配对助手在完成前已退出（请确认系统已允许 U-Brain / U-Brain Muse Pair 使用蓝牙）",
                  ),
            );
          }
        });
        conn.on("error", () => {
          if (!finished && !completed) {
            finish(new MuseError("与蓝牙配对助手的本地连接中断"));
          }
        });
      });

      let child: ReturnType<typeof spawn> | null = null;

      const finish = (error?: Error): void => {
        if (finished) return;
        finished = true;
        controller.disconnect();
        clearTimeout(timer);
        clearTimeout(connectTimer);
        options.signal?.removeEventListener("abort", aborted);
        ipcSocket?.destroy();
        server.close();
        child?.kill();
        if (error) reject(error);
        else resolveResult(credentials);
      };

      const aborted = (): void => finish(new MuseError("配对已取消"));
      const timer = setTimeout(() => finish(new MuseError("配对超时（10 分钟内未完成）")), 600_000);
      const connectTimer = setTimeout(() => {
        if (!ipcSocket) {
          finish(
            new MuseError(
              stderrTail.trim()
                ? `无法启动蓝牙配对助手：${stderrTail.trim().slice(0, 200)}`
                : "蓝牙配对助手未能启动，请检查系统蓝牙权限设置",
            ),
          );
        }
      }, 15_000);

      const controller = new PairingController({
        session: new PairingSession(identity),
        sdkToken,
        probe: options.probe,
        online: networkReady,
        send: (packets) => send({ event: "packets", packets: packets.map((p) => p.toString("base64")) }),
        progress: (msg) => {
          if (msg.includes("验证")) phase = "verifying";
          report(phase, msg);
        },
        verify: async (value) => {
          const vms = await new MuseAccount({ credentials: { ...value, refreshToken: "" } }).listVMs();
          if (!vms.length) throw new MuseError("账号下未找到可用的 Muse VM");
        },
        save: (value) => {
          if (existsSync(join(directory, "pairing.json"))) throw new MuseError("配对文件已存在");
          writePrivate(
            join(directory, "pairing.json"),
            JSON.stringify(
              {
                access_token: value.accessToken,
                refresh_token: value.refreshToken,
                token_type: "device",
                api_url_v2: value.apiUrl ?? "",
                noise_host: value.noiseHost ?? "",
                access_token_saved_at: value.savedAt,
                sdk_token_hint: value.sdkTokenHint,
              },
              null,
              2,
            ),
          );
        },
        complete: (value) => {
          completed = true;
          credentials = value;
          send({ event: "complete" });
        },
        failed: (error) => finish(error),
      });

      options.signal?.addEventListener("abort", aborted, { once: true });
      if (options.signal?.aborted) {
        aborted();
        return;
      }

      server.on("error", () => finish(new MuseError("无法创建本地蓝牙配对通信通道")));
      server.listen(sockPath, () => {
        // Launch via LaunchServices (`open -W -n`) so macOS TCC evaluates `U-Brain Muse Pair.app`'s own Info.plist!
        child = spawn("/usr/bin/open", ["-W", "-n", appBundle, "--args", "--socket", sockPath], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          if (stderrTail.length < 1_024) stderrTail += chunk;
        });
        child.on("error", () => finish(new MuseError("无法拉起蓝牙配对助手应用")));
        child.on("close", () => {
          if (!ipcSocket && !finished) {
            finish(
              new MuseError(
                stderrTail.trim()
                  ? `蓝牙配对助手启动失败：${stderrTail.trim().slice(0, 200)}`
                  : "蓝牙配对助手在连接前已退出（请在系统设置 > 隐私与安全性 > 蓝牙中允许权限）",
              ),
            );
          }
        });
      });
    });
  } finally {
    closeSync(lock);
    if (existsSync(lockPath)) unlinkSync(lockPath);
    await rm(sockDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
