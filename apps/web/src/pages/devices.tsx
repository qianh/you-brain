import { useState } from "react";

import { useDaemon } from "../daemon-context.js";
import { BrowserDaemonError } from "../api/client.js";
import { Empty } from "../components/ui.js";
import { capabilityLabel, kindLabel, platformLabel } from "../lib/copy.js";
import { formatDateTime } from "../lib/format.js";

export function DevicesPage() {
  const { t, language, devices, roles, status, client, replaceRoles, timeZone } = useDaemon();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const mainId = roles?.mainDevice ?? null;
  const webId = roles?.webProcessor ?? null;

  async function save(patch: { mainDevice?: string | null; webProcessor?: string | null }, key: string) {
    setBusy(key);
    setError(null);
    try {
      const next = await client.updateRoles(patch);
      replaceRoles(next);
    } catch (caught) {
      setError(caught instanceof BrowserDaemonError ? caught.message : t("actionFailed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("devices")}</h1>
          <p>{t("devicesHint")}</p>
        </div>
      </header>
      <p className="muted">
        {mainId
          ? `${t("mainBadge")} · ${devices.find((device) => device.deviceId === mainId)?.displayName ?? mainId}`
          : t("noMain")}
        {" · "}
        {webId
          ? `${t("webBadge")} · ${devices.find((device) => device.deviceId === webId)?.displayName ?? webId}`
          : t("webFollowsMain")}
      </p>
      {error ? <p className="form-error">{error}</p> : null}
      {devices.length === 0 ? <Empty>{t("emptyDevices")}</Empty> : null}
      <ul className="device-list">
        {devices.map((device) => {
          const isMain = device.deviceId === mainId;
          const isWeb = webId === null ? isMain : device.deviceId === webId;
          return (
            <li key={device.deviceId} className="card device-card">
              <div>
                <h2>
                  {device.displayName}
                  {status?.deviceId === device.deviceId ? <span className="pill">{t("thisDevice")}</span> : null}
                  {isMain ? <span className="pill accent">{t("mainBadge")}</span> : null}
                  {isWeb ? <span className="pill">{t("webBadge")}</span> : null}
                </h2>
                <p className="muted">
                  {kindLabel(device.kind, language)} · {platformLabel(device.platform, language)}
                </p>
                <p>
                  {t("lastSeen")} {formatDateTime(device.lastSeenAt, language, timeZone)}
                </p>
                <p>
                  {t("lastActive")} {formatDateTime(device.lastActiveAt, language, timeZone)}
                </p>
                <p className="muted tiny">
                  {t("capabilities")}{" "}
                  {device.capabilities.map((item) => capabilityLabel(item, language)).join(" · ")}
                </p>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={busy !== null || isMain}
                  onClick={() => void save({ mainDevice: device.deviceId }, `main-${device.deviceId}`)}
                >
                  {busy === `main-${device.deviceId}` ? t("working") : t("setMain")}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy !== null || (webId !== null && device.deviceId === webId)}
                  onClick={() => void save({ webProcessor: device.deviceId }, `web-${device.deviceId}`)}
                >
                  {busy === `web-${device.deviceId}` ? t("working") : t("setWeb")}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {webId !== null ? (
        <button
          type="button"
          className="btn quiet"
          disabled={busy !== null}
          onClick={() => void save({ webProcessor: null }, "web-clear")}
        >
          {t("clearWeb")}
        </button>
      ) : null}
    </div>
  );
}
