import type { DispatchDeviceView } from "@you-brain/core/http/types.js";
import type { DeviceRecord } from "@you-brain/protocol";

import { Button } from "../../components/button.js";
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

export interface RelayPeerTrustInfo {
  relayById: ReadonlyMap<string, DispatchDeviceView>;
  extraRelayPeers: readonly DispatchDeviceView[];
  trustedIds: ReadonlySet<string> | null;
  canTrust: boolean;
  trustingIds: Readonly<Record<string, boolean>>;
  onTrust: (deviceId: string, name: string) => void;
}

export function DeviceGrid({
  devices,
  localId,
  mainId,
  relayTrust,
  language,
  timeZone,
  t,
}: {
  devices: readonly DeviceRecord[];
  localId: string | null;
  mainId: string | null;
  relayTrust?: RelayPeerTrustInfo;
  language: Language;
  timeZone: string;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  const totalCount = devices.length + (relayTrust?.extraRelayPeers.length ?? 0);
  return (
    <>
      <div className="devices-grid">
        {devices.map((device) => {
          const relayPeer = relayTrust?.relayById.get(device.deviceId);
          const local = device.deviceId === localId;
          const trusted = !local && relayTrust?.trustedIds !== null && relayTrust?.trustedIds.has(device.deviceId) === true;
          const showTrustBtn =
            !local &&
            relayTrust?.canTrust === true &&
            relayPeer?.enrolled === true &&
            relayTrust.trustedIds !== null &&
            !trusted;
          return (
            <DeviceCard
              key={device.deviceId}
              device={device}
              local={local}
              main={device.deviceId === mainId}
              relayOnline={relayPeer?.online ?? null}
              trusted={trusted}
              showTrustBtn={showTrustBtn}
              trusting={relayTrust?.trustingIds[device.deviceId] === true}
              onTrust={() => relayTrust?.onTrust(device.deviceId, device.displayName)}
              language={language}
              timeZone={timeZone}
              t={t}
            />
          );
        })}
        {relayTrust?.extraRelayPeers.map((peer) => {
          const trusted = !peer.self && relayTrust.trustedIds !== null && relayTrust.trustedIds.has(peer.id);
          const showTrustBtn =
            !peer.self &&
            relayTrust.canTrust &&
            peer.enrolled &&
            relayTrust.trustedIds !== null &&
            !trusted;
          return (
            <RelayPeerCard
              key={peer.id}
              peer={peer}
              trusted={trusted}
              showTrustBtn={showTrustBtn}
              trusting={relayTrust.trustingIds[peer.id] === true}
              onTrust={() => relayTrust.onTrust(peer.id, peer.name)}
              t={t}
            />
          );
        })}
      </div>
      {showAddDeviceHint(totalCount) ? <AddDeviceCard title={t("devicesAddTitle")} body={t("devicesAddBody")} /> : null}
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
  relayOnline,
  trusted,
  showTrustBtn,
  trusting,
  onTrust,
  language,
  timeZone,
  t,
}: {
  device: DeviceRecord;
  local: boolean;
  main: boolean;
  relayOnline: boolean | null;
  trusted: boolean;
  showTrustBtn: boolean;
  trusting: boolean;
  onTrust: () => void;
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
            {trusted ? <Chip tone="success">{t("dispatchDeviceTrusted")}</Chip> : null}
            {relayOnline !== null ? (
              <Chip tone={relayOnline ? "success" : "neutral"} dot>
                {relayOnline ? t("dispatchDeviceOnline") : t("dispatchDeviceOffline")}
              </Chip>
            ) : null}
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
        {showTrustBtn ? (
          <Button size="sm" variant="secondary" loading={trusting} onClick={onTrust}>
            {t("dispatchTrustDeviceBtn")}
          </Button>
        ) : null}
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

function RelayPeerCard({
  peer,
  trusted,
  showTrustBtn,
  trusting,
  onTrust,
  t,
}: {
  peer: DispatchDeviceView;
  trusted: boolean;
  showTrustBtn: boolean;
  trusting: boolean;
  onTrust: () => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  return (
    <Card className="devices-card">
      <div className="devices-card-top">
        <DeviceTile kind="virtual" />
        <div className="devices-card-copy">
          <div className="devices-card-title">
            <span className="devices-card-name" title={peer.name}>
              {peer.name}
            </span>
            {peer.self ? <Chip tone="accent">{t("thisDevice")}</Chip> : null}
            {trusted ? <Chip tone="success">{t("dispatchDeviceTrusted")}</Chip> : null}
            <Chip tone={peer.enrolled ? "success" : "neutral"}>
              {peer.enrolled ? t("dispatchDeviceEnrolled") : t("dispatchDeviceNotEnrolled")}
            </Chip>
          </div>
          <p className="devices-line">
            <i className={peer.online ? "dot dot-ok" : "dot dot-muted"} aria-hidden="true" />
            <span>{peer.online ? t("dispatchDeviceOnline") : t("dispatchDeviceOffline")}</span>
          </p>
        </div>
        {showTrustBtn ? (
          <Button size="sm" variant="secondary" loading={trusting} onClick={onTrust}>
            {t("dispatchTrustDeviceBtn")}
          </Button>
        ) : null}
      </div>
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
