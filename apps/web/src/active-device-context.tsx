import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { BrowserDaemon } from "./api/client.js";
import { prefs } from "./lib/prefs.js";

/** 全局当前工作设备（指挥台 T3 / 终端 与 TODO 双向共享）；"local" 表示本机，其余为同账号远端设备 ID。 */
export const ACTIVE_DEVICE_KEY = "you-brain.active-device";
const DEVICE_POLL_MS = 20_000;

export interface ManagedDevice {
  id: string;
  name: string;
  online: boolean;
  enrolled: boolean;
  canT3: boolean;
  canRd: boolean;
  canTodo: boolean;
}

export interface ManualT3EndpointInfo {
  id: string;
  name: string;
}

export interface ActiveDeviceValue {
  /** 同账号已入网远端设备（统一排序：在线且开放能力优先 → 在线 → 离线 → 名称）。 */
  devices: ManagedDevice[];
  /** 是否已完成至少一次设备列表加载。 */
  devicesLoaded: boolean;
  /** null 表示本机；非空表示当前选中的同账号远端设备 ID。 */
  activeDeviceId: string | null;
  /** 当前选中的远端设备信息（中途离线仍保留名称与离线状态，不静默跳走）。 */
  activeDevice: ManagedDevice | null;
  /** 指挥台停留在手动 URL 端点时记录（TODO 自动回退本机并展示提示）。 */
  manualT3Endpoint: ManualT3EndpointInfo | null;
  selectDevice: (deviceId: string | null) => void;
  selectManualT3Endpoint: (endpoint: ManualT3EndpointInfo | null) => void;
  reloadDevices: () => Promise<void>;
}

const ActiveDeviceContext = createContext<ActiveDeviceValue | null>(null);

function readStoredDeviceId(): string | null {
  try {
    const raw = prefs.getItem(ACTIVE_DEVICE_KEY)?.trim() ?? "";
    if (raw === "" || raw === "local") return null;
    return raw;
  } catch {
    return null;
  }
}

function writeStoredDeviceId(deviceId: string | null): void {
  try {
    prefs.setItem(ACTIVE_DEVICE_KEY, deviceId ?? "local");
  } catch {
    // 偏好写入失败不影响本次切换。
  }
}

export function sortManagedDevices(list: readonly ManagedDevice[]): ManagedDevice[] {
  return [...list].sort((a, b) => {
    const aReady = a.online && (a.canT3 || a.canTodo || a.canRd) ? 1 : 0;
    const bReady = b.online && (b.canT3 || b.canTodo || b.canRd) ? 1 : 0;
    if (aReady !== bReady) return bReady - aReady;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function sameDevices(a: readonly ManagedDevice[], b: readonly ManagedDevice[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (item, index) =>
        item.id === b[index]?.id &&
        item.name === b[index]?.name &&
        item.online === b[index]?.online &&
        item.enrolled === b[index]?.enrolled &&
        item.canT3 === b[index]?.canT3 &&
        item.canRd === b[index]?.canRd &&
        item.canTodo === b[index]?.canTodo,
    )
  );
}

export function ActiveDeviceProvider({ client, children }: { client: BrowserDaemon; children: ReactNode }) {
  const [devices, setDevices] = useState<ManagedDevice[]>([]);
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(readStoredDeviceId);
  const [manualT3Endpoint, setManualT3Endpoint] = useState<ManualT3EndpointInfo | null>(null);
  /** 记住见过的设备信息，防止运行中某设备短暂从列表消失时丢失显示名。 */
  const knownMapRef = useRef<Map<string, ManagedDevice>>(new Map());
  /** 首次拉取设备列表前若持久化了远端设备，启动时若该设备已离线则回落本机；运行中用户切过去后中途断线不跳走。 */
  const startupResolvedRef = useRef(activeDeviceId === null);
  const activeDeviceIdRef = useRef(activeDeviceId);
  activeDeviceIdRef.current = activeDeviceId;

  const reloadDevices = useCallback(async (): Promise<void> => {
    if (typeof client.dispatchDevices !== "function") return;
    try {
      const response = await client.dispatchDevices();
      const next = sortManagedDevices(
        response.devices
          .filter((device) => !device.self && device.enrolled)
          .map((device) => ({
            id: device.id,
            name: device.name,
            online: device.online,
            enrolled: device.enrolled,
            canT3: device.dispatch?.viewT3 === true,
            canRd: device.dispatch?.remoteDesktop === true,
            canTodo: device.dispatch?.enabled === true,
          })),
      );
      for (const item of next) knownMapRef.current.set(item.id, item);
      setDevices((current) => (sameDevices(current, next) ? current : next));
      setDevicesLoaded(true);

      if (!startupResolvedRef.current) {
        startupResolvedRef.current = true;
        const storedId = activeDeviceIdRef.current;
        if (storedId !== null) {
          const found = next.find((item) => item.id === storedId);
          if (!found || !found.online) {
            setActiveDeviceId(null);
            writeStoredDeviceId(null);
          }
        }
      }
    } catch {
      // 轮询失败时保留上次状态。
    }
  }, [client]);

  useEffect(() => {
    void reloadDevices();
    const timer = window.setInterval(() => {
      void reloadDevices();
    }, DEVICE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [reloadDevices]);

  const selectDevice = useCallback((deviceId: string | null): void => {
    startupResolvedRef.current = true;
    setManualT3Endpoint(null);
    setActiveDeviceId(deviceId);
    writeStoredDeviceId(deviceId);
  }, []);

  const selectManualT3Endpoint = useCallback((endpoint: ManualT3EndpointInfo | null): void => {
    startupResolvedRef.current = true;
    setManualT3Endpoint(endpoint);
    if (endpoint !== null) {
      // 切到手动添加的 T3 地址（无 daemon 身份）时，TODO 回退本机并展示提示条。
      setActiveDeviceId(null);
      writeStoredDeviceId(null);
    }
  }, []);

  const activeDevice = useMemo<ManagedDevice | null>(() => {
    if (activeDeviceId === null) return null;
    const live = devices.find((item) => item.id === activeDeviceId);
    if (live) return live;
    const remembered = knownMapRef.current.get(activeDeviceId);
    if (remembered) return { ...remembered, online: false };
    return {
      id: activeDeviceId,
      name: activeDeviceId,
      online: false,
      enrolled: true,
      canT3: false,
      canRd: false,
      canTodo: false,
    };
  }, [activeDeviceId, devices]);

  const value = useMemo<ActiveDeviceValue>(
    () => ({
      devices,
      devicesLoaded,
      activeDeviceId,
      activeDevice,
      manualT3Endpoint,
      selectDevice,
      selectManualT3Endpoint,
      reloadDevices,
    }),
    [devices, devicesLoaded, activeDeviceId, activeDevice, manualT3Endpoint, selectDevice, selectManualT3Endpoint, reloadDevices],
  );

  return <ActiveDeviceContext.Provider value={value}>{children}</ActiveDeviceContext.Provider>;
}

const FALLBACK_ACTIVE_DEVICE: ActiveDeviceValue = {
  devices: [],
  devicesLoaded: false,
  activeDeviceId: null,
  activeDevice: null,
  manualT3Endpoint: null,
  selectDevice: () => {},
  selectManualT3Endpoint: () => {},
  reloadDevices: async () => {},
};

export function useActiveDevice(): ActiveDeviceValue {
  return useContext(ActiveDeviceContext) ?? FALLBACK_ACTIVE_DEVICE;
}
