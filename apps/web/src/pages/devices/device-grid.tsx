import type { DeviceRecord } from "@you-brain/protocol";

import { Card } from "../../components/card.js";
import { Chip } from "../../components/chip.js";
import { Icon } from "../../components/icons.js";
import { Skeleton } from "../../components/skeleton.js";
import { DeviceTile } from "../../components/tile.js";
import type { MessageKey } from "../../i18n/messages.js";
import { capabilityLabel, kindLabel, platformLabel } from "../../lib/copy.js";
import { formatDateTime, type Language } from "../../lib/format.js";
import { useRelativeTime } from "../../components/use-relative-time.js";
import { hasRecordedActivity, isDeviceOnline, showAddDeviceHint } from "./logic.js";

export function DeviceGrid({
  devices,
  localId,
  mainId,
  webId,
  language,
  timeZone,
  t,
}: {
  devices: readonly DeviceRecord[];
  localId: string | null;
  mainId: string | null;
  webId: string | null;
  language: Language;
  timeZone: string;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  return (
    <>
      <div className="devices-grid">
        {devices.map((device) => (
          <DeviceCard
            key={device.deviceId}
            device={device}
            local={device.deviceId === localId}
            main={device.deviceId === mainId}
            web={webId !== null && device.deviceId === webId}
            language={language}
            timeZone={timeZone}
            t={t}
          />
        ))}
      </div>
      {showAddDeviceHint(devices.length) ? <AddDeviceCard title={t("devicesAddTitle")} body={t("devicesAddBody")} /> : null}
    </>
  );
}

export function DevicesSkeleton() {
  return (
    <div className="devices-grid" aria-hidden="true">
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}

function SkeletonCard() {
  return (
    <Card className="devices-card">
      <span className="devices-card-top">
        <Skeleton width={32} height={32} />
        <span className="devices-card-copy">
          <Skeleton width="55%" height={14} />
          <Skeleton width="40%" height={12} />
        </span>
      </span>
      <Skeleton width="70%" height={12} />
      <Skeleton width="46%" height={12} />
    </Card>
  );
}

function DeviceCard({
  device,
  local,
  main,
  web,
  language,
  timeZone,
  t,
}: {
  device: DeviceRecord;
  local: boolean;
  main: boolean;
  web: boolean;
  language: Language;
  timeZone: string;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  const seen = useRelativeTime(device.lastSeenAt, language, timeZone);
  const active = useRelativeTime(device.lastActiveAt, language, timeZone);
  const recorded = hasRecordedActivity(device.lastActiveAt);
  const online = isDeviceOnline(device.lastSeenAt);
  const seenAbsolute = formatDateTime(device.lastSeenAt, language, timeZone);
  const activeAbsolute = formatDateTime(device.lastActiveAt, language, timeZone);
  return (
    <Card className="devices-card">
      <div className="devices-card-top">
        <DeviceTile kind={device.kind} />
        <div className="devices-card-copy">
          <div className="devices-card-title">
            <span className="devices-card-name" title={device.displayName}>
              {device.displayName}
            </span>
            {local ? <Chip tone="accent">{t("thisDevice")}</Chip> : null}
            {main ? <Chip tone="success">{t("mainBadge")}</Chip> : null}
            {web ? <Chip>{t("webBadge")}</Chip> : null}
          </div>
          <p className="devices-line">
            <i className={online ? "dot dot-ok" : "dot dot-muted"} aria-hidden="true" />
            <span>{online ? t("devicesOnline") : t("devicesOffline")}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={device.lastSeenAt} title={seenAbsolute}>
              {seen}
            </time>
          </p>
        </div>
      </div>
      <p className="devices-meta">
        {kindLabel(device.kind, language)}
        <span aria-hidden="true"> · </span>
        {platformLabel(device.platform, language)}
        <span aria-hidden="true"> · </span>
        {`v${device.appVersion}`}
      </p>
      {device.capabilities.length > 0 ? (
        <div className="devices-caps">
          {device.capabilities.map((item) => (
            <Chip key={item}>{capabilityLabel(item, language)}</Chip>
          ))}
        </div>
      ) : null}
      <p className="devices-active">
        {recorded ? (
          <>
            {t("lastActive")}{" "}
            <time dateTime={device.lastActiveAt} title={activeAbsolute}>
              {active}
            </time>
          </>
        ) : (
          t("lastActiveNever")
        )}
      </p>
    </Card>
  );
}

function AddDeviceCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="devices-add">
      <span className="devices-add-icon" aria-hidden="true">
        <Icon name="plus" />
      </span>
      <div className="devices-add-copy">
        <p className="devices-add-title">{title}</p>
        <p className="devices-add-body">{body}</p>
      </div>
    </div>
  );
}
