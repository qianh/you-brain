import type { ReactNode } from "react";
import type { DeviceRecord } from "@you-brain/protocol";

import { Card, Section } from "../../components/card.js";
import { Icon } from "../../components/icons.js";
import { Row } from "../../components/row.js";
import { Select, type SelectOption } from "../../components/select.js";
import { DeviceTile, Tile } from "../../components/tile.js";
import { Tooltip } from "../../components/tooltip.js";
import type { MessageKey } from "../../i18n/messages.js";
import { roleCandidates } from "./logic.js";

const UNSET = "";

export function RoleSection({
  devices,
  mainId,
  t,
  onMain,
}: {
  devices: readonly DeviceRecord[];
  mainId: string | null;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  onMain: (deviceId: string) => void;
}) {
  const mainDevices = roleCandidates(devices, "main", mainId);
  return (
    <Section title={t("devicesRoles")}>
      <Card>
        <RoleRow
          icon={
            <Tile>
              <Icon name="shield" />
            </Tile>
          }
          title={t("roleMainTitle")}
          hint={t("roleMainHint")}
          label={t("rolePickMain")}
          value={mainId ?? UNSET}
          placeholder={t("rolePickMain")}
          emptyHint={t("roleEmptyMain")}
          options={namedOptions(mainDevices, mainId)}
          onChange={(value) => {
            if (value !== "" && value !== (mainId ?? "")) onMain(value);
          }}
        />
      </Card>
    </Section>
  );
}

function deviceOption(device: DeviceRecord): SelectOption {
  return {
    value: device.deviceId,
    label: device.displayName,
    icon: <DeviceTile kind={device.kind} size="sm" />,
  };
}

function namedOptions(devices: readonly DeviceRecord[], currentId: string | null): SelectOption[] {
  const options = devices.map((device) => deviceOption(device));
  if (currentId !== null && currentId !== "" && !options.some((option) => option.value === currentId)) {
    options.push({ value: currentId, label: currentId });
  }
  return options;
}

function RoleRow({
  icon,
  title,
  hint,
  label,
  value,
  placeholder,
  emptyHint,
  options,
  onChange,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  label: string;
  value: string;
  placeholder: string;
  emptyHint: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
}) {
  const deviceChoices = options.filter((option) => option.value !== UNSET);
  const blocked = deviceChoices.length === 0;
  const select = (
    <span className="devices-select">
      <Select
        label={blocked ? `${label}。${emptyHint}` : label}
        value={value}
        placeholder={placeholder}
        disabled={blocked}
        options={options}
        onChange={onChange}
      />
    </span>
  );
  return (
    <Row
      icon={icon}
      title={title}
      subtitle={hint}
      titleText={title}
      trailing={blocked ? <Tooltip content={emptyHint}>{select}</Tooltip> : select}
    />
  );
}
