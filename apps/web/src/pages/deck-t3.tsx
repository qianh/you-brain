import { useEffect, useRef, useState, type RefObject } from "react";
import { DEFAULT_T3_URL, normalizeT3Url, type T3WebState } from "@you-brain/core/deck/t3/index.js";

import { Button, IconButton } from "../components/button.js";
import { Dialog } from "../components/dialog.js";
import { Icon } from "../components/icons.js";
import { FieldError, Input } from "../components/input.js";
import { Spinner } from "../components/spinner.js";
import { useDaemon } from "../daemon-context.js";
import { prefs } from "../lib/prefs.js";
import {
  addEndpoint,
  isDuplicateEndpointUrl,
  LOCAL_T3_ID,
  MAX_T3_ENDPOINT_NAME,
  MAX_T3_ENDPOINTS,
  parseEndpoints,
  removeEndpoint,
  resolveActive,
  serializeEndpoints,
  T3_ACTIVE_KEY,
  T3_ENDPOINTS_KEY,
  T3_URL_KEY,
  type AddEndpointError,
  type T3Endpoint,
} from "../lib/t3-endpoints.js";
import { t3FrameSrc } from "../lib/t3-frame.js";

const SETTINGS_FORM = "deck-t3-settings";
type T3View = T3WebState | { state: "checking" } | { state: "check-error" };
type LocalUrlError = "invalid-url" | "duplicate-url" | null;

function savedLocalUrl(): string {
  try {
    return normalizeT3Url(prefs.getItem(T3_URL_KEY) ?? "") ?? DEFAULT_T3_URL;
  } catch {
    return DEFAULT_T3_URL;
  }
}

function savedEndpoints(localUrl: string): T3Endpoint[] {
  try {
    return parseEndpoints(prefs.getItem(T3_ENDPOINTS_KEY), localUrl);
  } catch {
    return [];
  }
}

function savedActive(endpoints: readonly T3Endpoint[], threadUrl: string | null): string {
  if (threadUrl) return LOCAL_T3_ID;
  try {
    return resolveActive(prefs.getItem(T3_ACTIVE_KEY), endpoints);
  } catch {
    return LOCAL_T3_ID;
  }
}

import { DeckRemoteDesktopPane } from "./deck-remote-desktop.js";

/** 设备栏的轮询间隔：设备上线、开放 T3 或桌面协同后不用刷新页面就会出现。 */
const DEVICE_POLL_MS = 20_000;
const DEVICE_ID_PREFIX = "device:";

export interface DeviceTab {
  id: string;
  deviceId: string;
  name: string;
  canT3: boolean;
  canRd: boolean;
}

function DeckT3EndpointPane({
  url,
  deviceId,
  prewarmedFrameUrl,
  name,
  active,
  reloadCount,
  frameRef,
  threadUrl,
  onRetry,
  onOpenSettings,
  onProbeStart,
}: {
  url: string;
  /** 有值表示这是另一台设备的 T3（经设备间隧道），url 只用于显示。 */
  deviceId?: string;
  /** 后台预热已拿到的本地转发地址；首次切过去直接渲染 iframe，免去握手等待圈。 */
  prewarmedFrameUrl?: string;
  name: string;
  active: boolean;
  reloadCount: number;
  frameRef?: RefObject<HTMLIFrameElement | null>;
  threadUrl: string | null;
  onRetry: () => void;
  onOpenSettings: () => void;
  onProbeStart?: () => void;
}) {
  const { client, t } = useDaemon();
  const [view, setView] = useState<T3View | { state: "device-error"; reason: string }>(() =>
    deviceId !== undefined && prewarmedFrameUrl !== undefined && reloadCount === 0
      ? { state: "ready", url: prewarmedFrameUrl, frameUrl: prewarmedFrameUrl }
      : { state: "checking" },
  );
  const onProbeStartRef = useRef(onProbeStart);
  onProbeStartRef.current = onProbeStart;

  useEffect(() => {
    if (deviceId !== undefined && prewarmedFrameUrl !== undefined && reloadCount === 0) {
      setView((current) =>
        current.state === "ready" && current.frameUrl === prewarmedFrameUrl
          ? current
          : { state: "ready", url: prewarmedFrameUrl, frameUrl: prewarmedFrameUrl },
      );
      return;
    }
    let cancelled = false;
    setView({ state: "checking" });
    onProbeStartRef.current?.();
    if (deviceId !== undefined) {
      void client.deckT3Device(deviceId).then(
        (next) => {
          if (cancelled) return;
          setView(next.state === "ready" ? { state: "ready", url: next.frameUrl, frameUrl: next.frameUrl } : { state: "device-error", reason: next.reason });
        },
        () => { if (!cancelled) setView({ state: "check-error" }); },
      );
    } else {
      void client.deckT3(url).then(
        (next) => { if (!cancelled) setView(next); },
        () => { if (!cancelled) setView({ state: "check-error" }); },
      );
    }
    return () => { cancelled = true; };
  }, [client, url, deviceId, prewarmedFrameUrl, reloadCount]);

  return (
    <div className="deck-t3-pane" hidden={!active}>
      {view.state === "ready" ? (
        <iframe
          ref={frameRef}
          className="dsh-frame"
          src={t3FrameSrc(view, threadUrl)}
          title={`${t("dshDeckT3FrameTitle")} · ${name}`}
          allow="clipboard-read; clipboard-write"
          referrerPolicy="no-referrer"
          onError={() => setView({ state: "check-error" })}
        />
      ) : view.state === "checking" ? (
        <div className="dsh-deck-state" role="status">
          <Spinner />
          <p>{t("dshDeckT3Connecting")}</p>
        </div>
      ) : view.state === "device-error" ? (
        <div className="dsh-deck-state" role="status">
          <p className="dsh-deck-error">{t("dshDeckT3DeviceFailed", { reason: view.reason })}</p>
          <p className="dsh-deck-hint">{t("dshDeckT3DeviceHint")}</p>
          <div className="dsh-deck-actions">
            <Button size="sm" onClick={onRetry}>{t("dshDeckRetry")}</Button>
          </div>
        </div>
      ) : (
        <div className="dsh-deck-state" role="status">
          <p className="dsh-deck-error">{t(
            view.state === "check-error" ? "dshDeckT3CheckError" :
              view.reason === "not-t3" ? "dshDeckT3WrongService" :
                view.reason === "frame-blocked" ? "dshDeckT3FrameBlocked" : "dshDeckT3Unavailable",
          )}</p>
          <p className="dsh-deck-hint">{t("dshDeckT3StartHint")}</p>
          <code className="dsh-deck-address">{url}</code>
          <div className="dsh-deck-actions">
            <Button size="sm" onClick={onRetry}>{t("dshDeckRetry")}</Button>
            <Button size="sm" variant="ghost" onClick={onOpenSettings}>{t("dshDeckT3Settings")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export interface ActiveT3Device {
  id: string;
  name: string;
}

/** 首次切到 T3 时挂载，各端点按首次选中懒挂载并仅隐藏不卸载，保留各自会话与输入状态。 */
export function DeckT3Panel({
  reloadVersion,
  forceLocalVersion = 0,
  settingsOpen,
  onSettingsChange,
  onReload,
  onLocalReload,
  onActiveDeviceChange,
  onDevicesChange,
  frameRef,
  threadUrl,
  initialDeviceTabs = [],
}: {
  reloadVersion: number;
  /** 递增时强制切回本机端点（例如打开本机终端通知时）。 */
  forceLocalVersion?: number;
  settingsOpen: boolean;
  onSettingsChange: (open: boolean) => void;
  onReload: () => void;
  onLocalReload?: () => void;
  /** 当前激活端点是否为同账号下的远端设备；切到本机或手动地址端点时回调 null。 */
  onActiveDeviceChange?: (device: ActiveT3Device | null) => void;
  /** 同账号下当前在线且开放了 T3 的远端设备列表（用于预拉会话列表与保留设备显示名）。 */
  onDevicesChange?: (devices: ActiveT3Device[]) => void;
  frameRef?: RefObject<HTMLIFrameElement | null>;
  threadUrl: string | null;
  /** 测试可注入预设远端设备列表。 */
  initialDeviceTabs?: readonly DeviceTab[];
}) {
  const { client, t } = useDaemon();
  const [localUrl, setLocalUrl] = useState(savedLocalUrl);
  const [deviceTabs, setDeviceTabs] = useState<DeviceTab[]>(() => [...initialDeviceTabs]);
  const [warmedUrls, setWarmedUrls] = useState<Record<string, string>>({});
  const warmingDevicesRef = useRef(new Set<string>());
  const [endpoints, setEndpoints] = useState<T3Endpoint[]>(() => savedEndpoints(localUrl));
  const [activeId, setActiveId] = useState<string>(() => savedActive(endpoints, threadUrl));
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([activeId]));
  const [rdOpenDevices, setRdOpenDevices] = useState<ReadonlySet<string>>(() => new Set());
  const [reloadCounts, setReloadCounts] = useState<Record<string, number>>({});

  const [draft, setDraft] = useState(localUrl);
  const [localError, setLocalError] = useState<LocalUrlError>(null);
  const [addName, setAddName] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [addError, setAddError] = useState<AddEndpointError | null>(null);

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const rdOpenDevicesRef = useRef(rdOpenDevices);
  rdOpenDevicesRef.current = rdOpenDevices;
  const onActiveDeviceChangeRef = useRef(onActiveDeviceChange);
  onActiveDeviceChangeRef.current = onActiveDeviceChange;
  const onDevicesChangeRef = useRef(onDevicesChange);
  onDevicesChangeRef.current = onDevicesChange;

  const warmDevice = (deviceId: string): void => {
    if (typeof client.deckT3Device !== "function") return;
    if (warmingDevicesRef.current.has(deviceId)) return;
    warmingDevicesRef.current.add(deviceId);
    void client.deckT3Device(deviceId).then(
      (next) => {
        if (next.state === "ready") {
          setWarmedUrls((current) => (current[deviceId] === next.frameUrl ? current : { ...current, [deviceId]: next.frameUrl }));
        } else {
          warmingDevicesRef.current.delete(deviceId);
        }
      },
      () => {
        warmingDevicesRef.current.delete(deviceId);
      },
    );
  };

  // 同账号下已入网、在线、并向本机开放了 T3 或桌面协同的设备，自动列进标签栏。
  useEffect(() => {
    if (typeof client.dispatchDevices !== "function") return;
    const listDevices = client.dispatchDevices.bind(client);
    let cancelled = false;
    const load = (): void => {
      void listDevices().then(
        (response) => {
          if (cancelled) return;
          const next = response.devices
            .filter(
              (device) =>
                !device.self &&
                device.enrolled &&
                device.online &&
                (device.dispatch?.viewT3 === true || device.dispatch?.remoteDesktop === true),
            )
            .map((device) => ({
              id: `${DEVICE_ID_PREFIX}${device.id}`,
              deviceId: device.id,
              name: device.name,
              canT3: device.dispatch?.viewT3 === true,
              canRd: device.dispatch?.remoteDesktop === true,
            }));
          setDeviceTabs((current) =>
            current.length === next.length &&
            current.every(
              (tab, index) =>
                tab.id === next[index]?.id &&
                tab.name === next[index]?.name &&
                tab.canT3 === next[index]?.canT3 &&
                tab.canRd === next[index]?.canRd,
            )
              ? current
              : next,
          );
        },
        () => undefined,
      );
    };
    load();
    const timer = setInterval(load, DEVICE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client]);

  useEffect(() => {
    onDevicesChangeRef.current?.(
      deviceTabs.filter((tab) => tab.canT3).map((tab) => ({ id: tab.deviceId, name: tab.name })),
    );
    for (const tab of deviceTabs) {
      if (tab.canT3 && warmedUrls[tab.deviceId] === undefined) warmDevice(tab.deviceId);
    }
  }, [deviceTabs]);

  const closeRdForDevice = (deviceId: string, tabId?: string): void => {
    setRdOpenDevices((current) => {
      if (!current.has(deviceId)) return current;
      const copy = new Set(current);
      copy.delete(deviceId);
      return copy;
    });
    if (tabId) {
      setVisited((current) => (current.has(tabId) ? current : new Set([...current, tabId])));
    }
  };

  const openOrToggleRd = (tabId: string, deviceId: string, canT3: boolean): void => {
    const isCurrentDevice = activeId === tabId;
    const isRdOpen = rdOpenDevices.has(deviceId);
    if (isCurrentDevice && isRdOpen && canT3) {
      closeRdForDevice(deviceId, tabId);
      return;
    }
    setActiveId(tabId);
    setRdOpenDevices((current) => (current.has(deviceId) ? current : new Set([...current, deviceId])));
  };

  const selectEndpoint = (id: string, deviceMeta?: { deviceId: string; canT3: boolean; canRd: boolean }): void => {
    if (id.startsWith(DEVICE_ID_PREFIX)) {
      setActiveId(id);
      if (deviceMeta && !deviceMeta.canT3 && deviceMeta.canRd) {
        setRdOpenDevices((current) =>
          current.has(deviceMeta.deviceId) ? current : new Set([...current, deviceMeta.deviceId]),
        );
      } else if (deviceMeta) {
        closeRdForDevice(deviceMeta.deviceId);
        setVisited((current) => (current.has(id) ? current : new Set([...current, id])));
      } else {
        setVisited((current) => (current.has(id) ? current : new Set([...current, id])));
      }
      return;
    }
    const resolved = resolveActive(id, endpoints);
    setActiveId(resolved);
    setVisited((current) => (current.has(resolved) ? current : new Set([...current, resolved])));
    try { prefs.setItem(T3_ACTIVE_KEY, resolved); } catch { /* 本次切换仍可用。 */ }
  };

  const bumpReload = (id: string): void => {
    setReloadCounts((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }));
  };

  // 工具栏重新加载作用于当前端点；仅当本机端点重新探测时才通知父组件重置注入脚本状态。
  const prevReloadProp = useRef(reloadVersion);
  useEffect(() => {
    if (reloadVersion === prevReloadProp.current) return;
    prevReloadProp.current = reloadVersion;
    const currentId = activeIdRef.current;
    if (currentId.startsWith(DEVICE_ID_PREFIX)) {
      const devId = currentId.slice(DEVICE_ID_PREFIX.length);
      if (rdOpenDevicesRef.current.has(devId)) {
        bumpReload(`rd:${devId}`);
        return;
      }
    }
    bumpReload(currentId);
  }, [reloadVersion]);

  // 外部要求回到本机（例如点击本机终端通知）。
  const prevForceLocal = useRef(forceLocalVersion);
  useEffect(() => {
    if (forceLocalVersion === prevForceLocal.current) return;
    prevForceLocal.current = forceLocalVersion;
    setActiveId(LOCAL_T3_ID);
    setVisited((current) => (current.has(LOCAL_T3_ID) ? current : new Set([...current, LOCAL_T3_ID])));
    try { prefs.setItem(T3_ACTIVE_KEY, LOCAL_T3_ID); } catch { /* 本次切换仍可用。 */ }
  }, [forceLocalVersion]);

  // 会话深链来自本机 T3，切回本机端点。
  useEffect(() => {
    if (!threadUrl) return;
    setActiveId(LOCAL_T3_ID);
    setVisited((current) => (current.has(LOCAL_T3_ID) ? current : new Set([...current, LOCAL_T3_ID])));
    try { prefs.setItem(T3_ACTIVE_KEY, LOCAL_T3_ID); } catch { /* 本次切换仍可用。 */ }
  }, [threadUrl]);

  useEffect(() => {
    if (!settingsOpen) return;
    setDraft(localUrl);
    setLocalError(null);
    setAddName("");
    setAddUrl("");
    setAddError(null);
  }, [settingsOpen, localUrl]);

  const saveLocal = (): void => {
    const next = normalizeT3Url(draft);
    if (next === null) {
      setLocalError("invalid-url");
      return;
    }
    if (isDuplicateEndpointUrl(next, endpoints)) {
      setLocalError("duplicate-url");
      return;
    }
    setLocalUrl(next);
    try { prefs.setItem(T3_URL_KEY, next); } catch { /* 本次连接仍可用。 */ }
    onSettingsChange(false);
    if (activeId === LOCAL_T3_ID) onReload();
    else bumpReload(LOCAL_T3_ID);
  };

  const handleAddEndpoint = (): void => {
    const result = addEndpoint(endpoints, { name: addName, url: addUrl }, localUrl);
    if (!result.ok) {
      setAddError(result.error);
      return;
    }
    setEndpoints(result.endpoints);
    try { prefs.setItem(T3_ENDPOINTS_KEY, serializeEndpoints(result.endpoints)); } catch { /* 本次仍有效。 */ }
    setAddName("");
    setAddUrl("");
    setAddError(null);
  };

  const handleRemoveEndpoint = (id: string): void => {
    const next = removeEndpoint(endpoints, id);
    setEndpoints(next);
    try { prefs.setItem(T3_ENDPOINTS_KEY, serializeEndpoints(next)); } catch { /* 本次仍有效。 */ }
    setVisited((current) => {
      if (!current.has(id)) return current;
      const copy = new Set(current);
      copy.delete(id);
      return copy;
    });
    if (activeId === id) {
      setActiveId(LOCAL_T3_ID);
      setVisited((current) => (current.has(LOCAL_T3_ID) ? current : new Set([...current, LOCAL_T3_ID])));
      try { prefs.setItem(T3_ACTIVE_KEY, LOCAL_T3_ID); } catch { /* 本次仍有效。 */ }
    }
  };

  const addErrorText =
    addError === "invalid-url" ? t("dshDeckT3InvalidUrl") :
      addError === "duplicate-url" ? t("dshDeckT3DuplicateUrl") :
        addError === "limit" ? t("dshDeckT3EndpointLimit", { max: MAX_T3_ENDPOINTS }) : undefined;

  const localErrorText =
    localError === "invalid-url" ? t("dshDeckT3InvalidUrl") :
      localError === "duplicate-url" ? t("dshDeckT3DuplicateUrl") : undefined;

  const allEndpoints: Array<{
    id: string;
    name: string;
    url: string;
    isLocal: boolean;
    deviceId?: string;
    canT3: boolean;
    canRd: boolean;
  }> = [
    { id: LOCAL_T3_ID, name: t("dshDeckT3Local"), url: localUrl, isLocal: true, canT3: true, canRd: false },
    ...endpoints.map((endpoint) => ({ ...endpoint, isLocal: false, canT3: true, canRd: false })),
    ...deviceTabs.map((tab) => ({
      id: tab.id,
      name: tab.name,
      url: tab.name,
      isLocal: false,
      deviceId: tab.deviceId,
      canT3: tab.canT3,
      canRd: tab.canRd,
    })),
  ];
  // 当前设备标签随设备下线消失时，退回本机。
  const shownActiveId = allEndpoints.some((item) => item.id === activeId) ? activeId : LOCAL_T3_ID;
  const activeEntry = allEndpoints.find((item) => item.id === shownActiveId);
  const activeDeviceId = activeEntry?.deviceId !== undefined && activeEntry.canT3 ? activeEntry.deviceId : null;
  const activeDeviceName = activeDeviceId !== null && activeEntry ? activeEntry.name : null;

  useEffect(() => {
    onActiveDeviceChangeRef.current?.(
      activeDeviceId !== null && activeDeviceName !== null
        ? { id: activeDeviceId, name: activeDeviceName }
        : null,
    );
  }, [activeDeviceId, activeDeviceName]);

  return (
    <div className="deck-t3-root">
      <div className="deck-t3-bar">
        <div className="deck-t3-tabs" role="tablist" aria-label={t("dshDeckT3SwitchLabel")}>
          {allEndpoints.map((item) => {
            const selected = item.id === shownActiveId;
            const rdOpen = item.deviceId !== undefined && item.canRd && rdOpenDevices.has(item.deviceId);
            const tabButton = (
              <button
                key={item.canRd ? undefined : item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={[
                  "deck-t3-tab",
                  item.canRd ? "has-rd" : "",
                  selected && !rdOpen ? "is-active" : "",
                  selected && rdOpen ? "is-rd-active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                title={item.url}
                onMouseEnter={() => {
                  if (item.deviceId !== undefined && item.canT3 && warmedUrls[item.deviceId] === undefined) {
                    warmDevice(item.deviceId);
                  }
                }}
                onFocus={() => {
                  if (item.deviceId !== undefined && item.canT3 && warmedUrls[item.deviceId] === undefined) {
                    warmDevice(item.deviceId);
                  }
                }}
                onClick={() =>
                  selectEndpoint(
                    item.id,
                    item.deviceId !== undefined
                      ? { deviceId: item.deviceId, canT3: item.canT3, canRd: item.canRd }
                      : undefined,
                  )
                }
              >
                <Icon name={item.isLocal ? "laptop" : item.deviceId !== undefined ? "monitor" : "server"} size={14} />
                <span className="deck-t3-tab-name">{item.name}</span>
              </button>
            );

            if (item.deviceId !== undefined && item.canRd) {
              const targetDeviceId = item.deviceId;
              return (
                <div
                  key={item.id}
                  className={["deck-t3-device-group", selected ? "is-selected" : ""].filter(Boolean).join(" ")}
                >
                  {tabButton}
                  <button
                    type="button"
                    className={["deck-t3-rd-btn", selected && rdOpen ? "is-active" : ""].filter(Boolean).join(" ")}
                    title={t("deckRdOpen", { name: item.name })}
                    aria-label={t("deckRdOpen", { name: item.name })}
                    aria-pressed={selected && rdOpen}
                    onClick={() => openOrToggleRd(item.id, targetDeviceId, item.canT3)}
                  >
                    <Icon name="screen-share" size={13} />
                  </button>
                </div>
              );
            }
            return tabButton;
          })}
        </div>
        <IconButton
          className="deck-t3-add-trigger"
          label={t("dshDeckT3Settings")}
          onClick={() => onSettingsChange(true)}
        >
          <Icon name="plus" size={14} />
        </IconButton>
      </div>

      <div className="deck-t3-panes">
        {allEndpoints.map((item) => {
          const isActiveItem = item.id === shownActiveId;
          const isRdActive = item.deviceId !== undefined && item.canRd && rdOpenDevices.has(item.deviceId);
          return (
            <div key={item.id} className="deck-t3-slot" hidden={!isActiveItem}>
              {item.canT3 && visited.has(item.id) ? (
                <DeckT3EndpointPane
                  url={item.url}
                  {...(item.deviceId !== undefined ? { deviceId: item.deviceId } : {})}
                  {...(item.deviceId !== undefined && warmedUrls[item.deviceId] !== undefined ? { prewarmedFrameUrl: warmedUrls[item.deviceId] } : {})}
                  name={item.name}
                  active={isActiveItem && !isRdActive}
                  reloadCount={reloadCounts[item.id] ?? 0}
                  {...(item.isLocal && frameRef ? { frameRef } : {})}
                  threadUrl={item.isLocal ? threadUrl : null}
                  onRetry={() => bumpReload(item.id)}
                  onOpenSettings={() => onSettingsChange(true)}
                  {...(item.isLocal && onLocalReload ? { onProbeStart: onLocalReload } : {})}
                />
              ) : null}
              {item.deviceId !== undefined && item.canRd && rdOpenDevices.has(item.deviceId) ? (
                <DeckRemoteDesktopPane
                  deviceId={item.deviceId}
                  deviceName={item.name}
                  active={isActiveItem && isRdActive}
                  canBackToT3={item.canT3}
                  reloadCount={reloadCounts[`rd:${item.deviceId}`] ?? 0}
                  onBackToT3={() => closeRdForDevice(item.deviceId!, item.id)}
                />
              ) : null}
            </div>
          );
        })}
      </div>

      <Dialog
        open={settingsOpen}
        onClose={() => onSettingsChange(false)}
        title={t("dshDeckT3Settings")}
        description={t("dshDeckT3SettingsHint")}
        footer={
          <>
            <Button variant="ghost" onClick={() => onSettingsChange(false)}>{t("deckTty7Cancel")}</Button>
            <Button variant="primary" type="submit" form={SETTINGS_FORM}>{t("dshDeckT3Connect")}</Button>
          </>
        }
      >
        <div className="deck-t3-settings-sections">
          <form id={SETTINGS_FORM} className="dsh-deck-settings" onSubmit={(event) => { event.preventDefault(); saveLocal(); }}>
            <label htmlFor="deck-t3-url">{t("dshDeckT3Address")}</label>
            <Input
              id="deck-t3-url"
              value={draft}
              onChange={(event) => { setDraft(event.target.value); setLocalError(null); }}
              placeholder={DEFAULT_T3_URL}
              autoComplete="off"
              spellCheck={false}
              {...(localErrorText ? { error: localErrorText } : {})}
            />
          </form>

          <div className="deck-t3-remote-section">
            <div className="deck-t3-remote-head">
              <span className="deck-t3-remote-title">{t("dshDeckT3RemoteSection")}</span>
              <span className="deck-t3-remote-count">{endpoints.length}/{MAX_T3_ENDPOINTS}</span>
            </div>
            <p className="deck-t3-tunnel-hint">{t("dshDeckT3DeviceHint")}</p>
            <p className="deck-t3-tunnel-hint">{t("dshDeckT3TunnelHint")}</p>

            {endpoints.length > 0 ? (
              <ul className="deck-t3-endpoint-list">
                {endpoints.map((endpoint) => (
                  <li key={endpoint.id} className="deck-t3-endpoint-row">
                    <div className="deck-t3-endpoint-meta">
                      <span className="deck-t3-endpoint-name">{endpoint.name}</span>
                      <code className="deck-t3-endpoint-url">{endpoint.url}</code>
                    </div>
                    <IconButton
                      className="deck-t3-endpoint-remove"
                      label={t("dshDeckT3RemoveEndpoint")}
                      onClick={() => handleRemoveEndpoint(endpoint.id)}
                    >
                      <Icon name="trash" size={14} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="deck-t3-remote-empty">{t("dshDeckT3RemoteEmpty")}</p>
            )}

            <form
              className="deck-t3-add-form"
              onSubmit={(event) => {
                event.preventDefault();
                handleAddEndpoint();
              }}
            >
              <div className="deck-t3-add-fields">
                <Input
                  label={t("dshDeckT3EndpointName")}
                  value={addName}
                  onChange={(event) => { setAddName(event.target.value); setAddError(null); }}
                  placeholder={t("dshDeckT3EndpointNamePlaceholder")}
                  maxLength={MAX_T3_ENDPOINT_NAME}
                  autoComplete="off"
                />
                <Input
                  label={t("dshDeckT3EndpointUrl")}
                  value={addUrl}
                  onChange={(event) => { setAddUrl(event.target.value); setAddError(null); }}
                  placeholder="http://127.0.0.1:3774/"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button
                  size="sm"
                  type="submit"
                  icon={<Icon name="plus" size={14} />}
                  disabled={endpoints.length >= MAX_T3_ENDPOINTS}
                >
                  {t("dshDeckT3AddEndpoint")}
                </Button>
              </div>
              {addErrorText ? <FieldError>{addErrorText}</FieldError> : null}
            </form>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
