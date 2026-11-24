import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DispatchDevicesResponse, DispatchPolicyResponse } from "@you-brain/core/http/types.js";
import type { Roles } from "@you-brain/protocol";

import { useDelayed } from "../components/use-delayed.js";
import { Button } from "../components/button.js";
import { EmptyState } from "../components/empty.js";
import { PageHeader } from "../components/page.js";
import { Section } from "../components/card.js";
import { useToast } from "../components/toast.js";
import { useDaemon } from "../daemon-context.js";
import { deviceLabel } from "../lib/format.js";
import { DeviceGrid, DevicesSkeleton, type RelayPeerTrustInfo } from "./devices/device-grid.js";
import { orderDevices } from "./devices/logic.js";
import { RoleSection } from "./devices/role-section.js";

type RolePatch = { mainDevice?: string | null; webProcessor?: string | null };

export function DevicesPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t, language, devices, roles, status, client, replaceRoles, timeZone, loading, error, reload } = useDaemon();
  const { push } = useToast();
  const rolesRef = useRef(roles);
  rolesRef.current = roles;
  const generation = useRef(0);
  const ordered = orderDevices(devices, status?.deviceId ?? null);
  const waiting = loading && devices.length === 0 && roles === null;
  const delayed = useDelayed(waiting);
  const failed = !waiting && devices.length === 0 && roles === null && error !== null;
  const mainId = roles?.mainDevice ?? null;

  const [relayDevices, setRelayDevices] = useState<DispatchDevicesResponse | null>(null);
  const [dispatchPolicy, setDispatchPolicy] = useState<DispatchPolicyResponse | null>(null);
  const [trustingIds, setTrustingIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    if (typeof client.dispatchDevices === "function") {
      void client
        .dispatchDevices()
        .then((next) => {
          if (!cancelled) setRelayDevices(next);
        })
        .catch(() => undefined);
    }
    if (typeof client.dispatchPolicy === "function") {
      void client
        .dispatchPolicy()
        .then((next) => {
          if (!cancelled) setDispatchPolicy(next);
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [client]);

  const handleTrustDevice = useCallback(
    async (deviceId: string, name: string) => {
      if (typeof client.dispatchTrustDevice !== "function") return;
      setTrustingIds((current) => ({ ...current, [deviceId]: true }));
      try {
        const saved = await client.dispatchTrustDevice({ deviceId });
        setDispatchPolicy(saved);
        push({ message: t("dispatchTrustDeviceOk", { name }), tone: "success" });
      } catch (caught) {
        const message = caught instanceof Error && caught.message.trim() !== "" ? caught.message : t("dispatchPolicySaveFailed");
        push({ message, tone: "danger" });
      } finally {
        setTrustingIds((current) => ({ ...current, [deviceId]: false }));
      }
    },
    [client, push, t],
  );

  const relayTrust = useMemo<RelayPeerTrustInfo | undefined>(() => {
    if (!relayDevices) return undefined;
    const driveIds = new Set(ordered.map((item) => item.deviceId));
    const relayById = new Map(relayDevices.devices.map((peer) => [peer.id, peer]));
    const extraRelayPeers = relayDevices.devices.filter((peer) => !driveIds.has(peer.id) && (!peer.self || ordered.length === 0));
    const trustedIds = dispatchPolicy?.trustedDeviceIds ? new Set(dispatchPolicy.trustedDeviceIds) : null;
    return {
      relayById,
      extraRelayPeers,
      trustedIds,
      canTrust: typeof client.dispatchTrustDevice === "function",
      trustingIds,
      onTrust: (deviceId, name) => {
        void handleTrustDevice(deviceId, name);
      },
    };
  }, [client.dispatchTrustDevice, dispatchPolicy?.trustedDeviceIds, handleTrustDevice, ordered, relayDevices, trustingIds]);

  async function save(patch: RolePatch, message: string, undoable: boolean) {
    const previous = rolesRef.current;
    if (!previous) return;
    const id = generation.current + 1;
    generation.current = id;
    replaceRoles({ ...previous, ...patch });
    try {
      const saved = await client.updateRoles(patch);
      if (generation.current !== id) return;
      replaceRoles(saved);
      const undo = undoPatch(previous, patch);
      push({
        message,
        tone: "success",
        ...(undoable
          ? {
              action: {
                label: t("undo"),
                onClick: () => {
                  void save(undo, t("roleUndone"), false);
                },
              },
            }
          : {}),
      });
    } catch {
      if (generation.current !== id) return;
      replaceRoles(previous);
      push({ message: t("roleReverted"), tone: "danger" });
    }
  }

  const totalCount = ordered.length + (relayTrust?.extraRelayPeers.length ?? 0);

  return (
    <div className="devices-page">
      {embedded ? null : <PageHeader title={t("devices")} description={t("devicesLead")} />}
      {waiting ? (
        delayed ? (
          <DevicesSkeleton />
        ) : (
          <div className="devices-hold" aria-busy="true" />
        )
      ) : null}
      {failed ? (
        <EmptyState
          icon="laptop"
          title={t("devicesUnavailable")}
          description={t("devicesUnavailableBody")}
          action={
            <Button variant="primary" onClick={() => void reload("all")}>
              {t("retry")}
            </Button>
          }
        />
      ) : null}
      {!waiting && !failed ? (
        <div className="devices-stack">
          {roles ? (
            <RoleSection
              devices={ordered}
              mainId={mainId}
              t={t}
              onMain={(deviceId) => {
                void save(
                  { mainDevice: deviceId, webProcessor: null },
                  t("roleMainSet", { name: deviceLabel(deviceId, ordered) }),
                  true,
                );
              }}
            />
          ) : null}
          <Section
            title={t("devices")}
            {...(totalCount > 0 ? { hint: t("devicesCount", { count: totalCount }) } : {})}
          >
            {totalCount === 0 ? (
              <EmptyState icon="laptop" title={t("emptyDevices")} description={t("devicesEmptyBody")} />
            ) : (
              <DeviceGrid
                devices={ordered}
                localId={status?.deviceId ?? null}
                mainId={mainId}
                {...(relayTrust ? { relayTrust } : {})}
                language={language}
                timeZone={timeZone}
                t={t}
              />
            )}
          </Section>
        </div>
      ) : null}
    </div>
  );
}

function undoPatch(previous: Roles, patch: RolePatch): RolePatch {
  const undo: RolePatch = {};
  if ("mainDevice" in patch) undo.mainDevice = previous.mainDevice;
  if ("webProcessor" in patch) undo.webProcessor = previous.webProcessor;
  return undo;
}
