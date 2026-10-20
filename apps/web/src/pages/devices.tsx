import { useState } from "react";

import { useDaemon } from "../daemon-context.js";
import { BrowserDaemonError } from "../api/client.js";
import { Card } from "../components/card.js";
import { EmptyState } from "../components/empty.js";
import { Icon } from "../components/icons.js";
import { Pill } from "../components/pill.js";
import { Row } from "../components/row.js";
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
      {devices.length === 0 ? <EmptyState title={t("emptyDevices")} icon="laptop" /> : null}
      {devices.length > 0 ? (
        <Card>
          {devices.map((device) => {
            const isMain = device.deviceId === mainId;
            const isWeb = webId === null ? isMain : device.deviceId === webId;
            const here = status?.deviceId === device.deviceId;
            return (
              <Row
                key={device.deviceId}
                className="stack-narrow"
                icon={<Icon name={device.kind === "server" ? "server" : "laptop"} />}
                title={
                  <span className="pill-row">
                    <span>{device.displayName}</span>
                    {here ? <Pill>{t("thisDevice")}</Pill> : null}
                    {isMain ? <Pill pressed>{t("mainBadge")}</Pill> : null}
                    {isWeb ? <Pill>{t("webBadge")}</Pill> : null}
                  </span>
                }
                subtitle={
                  <>
                    <i className={here ? "dot dot-ok" : "dot dot-muted"} />
                    <span>
                      {kindLabel(device.kind, language)} · {platformLabel(device.platform, language)}
                    </span>
                    <span>
                      {" · "}
                      {t("lastSeen")} {formatDateTime(device.lastSeenAt, language, timeZone)}
                    </span>
                    <span>
                      {" · "}
                      {t("lastActive")} {formatDateTime(device.lastActiveAt, language, timeZone)}
                    </span>
                    <span>
                      {" · "}
                      {device.capabilities.map((item) => capabilityLabel(item, language)).join(" · ")}
                    </span>
                  </>
                }
                trailing={
                  <>
                    <button
                      type="button"
                      className="btn small"
                      disabled={busy !== null || isMain}
                      onClick={() => void save({ mainDevice: device.deviceId }, `main-${device.deviceId}`)}
                    >
                      {busy === `main-${device.deviceId}` ? t("working") : t("setMain")}
                    </button>
                    <button
                      type="button"
                      className="btn small"
                      disabled={busy !== null || (webId !== null && device.deviceId === webId)}
                      onClick={() => void save({ webProcessor: device.deviceId }, `web-${device.deviceId}`)}
                    >
                      {busy === `web-${device.deviceId}` ? t("working") : t("setWeb")}
                    </button>
                  </>
                }
              />
            );
          })}
        </Card>
      ) : null}
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
