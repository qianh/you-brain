import type { IconName } from "../../components/icons.js";
import type { MessageKey } from "../../i18n/messages.js";
import { SETTINGS_SECTIONS, type SettingsSection } from "../../lib/route.js";

export interface SettingsNavItem {
  id: SettingsSection;
  label: MessageKey;
  hint: MessageKey;
  icon: IconName;
}

export const SETTINGS_NAV: readonly SettingsNavItem[] = [
  { id: "account", label: "groupAccountDrive", hint: "accountHint", icon: "user" },
  { id: "model", label: "groupModel", hint: "modelHint", icon: "cpu" },
  { id: "status", label: "navStatus", hint: "statusHint", icon: "activity" },
  { id: "devices", label: "navDevices", hint: "devicesHint", icon: "laptop" },
  { id: "capture", label: "navCapture", hint: "captureHint", icon: "inbox" },
  { id: "refine", label: "navRefine", hint: "refineHint", icon: "sparkles" },
  { id: "consolidation", label: "navConsolidation", hint: "consolidationHint", icon: "bell" },
  { id: "portrait", label: "portrait", hint: "settingsPortraitHint", icon: "book-open" },
  { id: "integrations", label: "navIntegrations", hint: "integrationsHint", icon: "plug" },
  { id: "appearance", label: "navAppearance", hint: "settingsNow", icon: "palette" },
];

export function settingsNavItem(section: SettingsSection): SettingsNavItem {
  const found = SETTINGS_NAV.find((item) => item.id === section);
  return found ?? SETTINGS_NAV[0]!;
}

export function nextSection(section: SettingsSection, delta: number): SettingsSection {
  const index = SETTINGS_SECTIONS.indexOf(section);
  const count = SETTINGS_SECTIONS.length;
  const next = (index + delta + count) % count;
  return SETTINGS_SECTIONS[next] ?? "account";
}
