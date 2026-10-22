import { useRef } from "react";
import type { Roles } from "@you-brain/protocol";

import { useDelayed } from "../components/use-delayed.js";
import { Button } from "../components/button.js";
import { EmptyState } from "../components/empty.js";
import { PageHeader } from "../components/page.js";
import { Section } from "../components/card.js";
import { useToast } from "../components/toast.js";
import { useDaemon } from "../daemon-context.js";
import { deviceLabel } from "../lib/format.js";
import { DeviceGrid, DevicesSkeleton } from "./devices/device-grid.js";
import { orderDevices, resolvedWebDevice } from "./devices/logic.js";
import { RoleSection } from "./devices/role-section.js";

type RolePatch = { mainDevice?: string | null; webProcessor?: string | null };

export function DevicesPage() {
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
  const webId = roles?.webProcessor ?? null;

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

  return (
    <div className="devices-page">
      <PageHeader title={t("devices")} description={t("devicesLead")} />
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
              webId={webId}
              t={t}
              onMain={(deviceId) => {
                void save({ mainDevice: deviceId }, t("roleMainSet", { name: deviceLabel(deviceId, ordered) }), true);
              }}
              onWeb={(deviceId) => {
                const name = deviceId === null ? "" : deviceLabel(deviceId, ordered);
                const message = deviceId === null ? t("roleWebCleared") : t("roleWebSet", { name });
                void save({ webProcessor: deviceId }, message, true);
              }}
            />
          ) : null}
          <Section
            title={t("devices")}
            {...(ordered.length > 0 ? { hint: t("devicesCount", { count: ordered.length }) } : {})}
          >
            {ordered.length === 0 ? (
              <EmptyState icon="laptop" title={t("emptyDevices")} description={t("devicesEmptyBody")} />
            ) : (
              <DeviceGrid
                devices={ordered}
                localId={status?.deviceId ?? null}
                mainId={mainId}
                webId={resolvedWebDevice(mainId, webId)}
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
