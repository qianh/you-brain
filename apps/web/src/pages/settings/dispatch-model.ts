import type {
  DispatchDeviceView,
  DispatchKnownSenderView,
  DispatchOutboxEntry,
  DispatchPolicyPutBody,
  DispatchPolicyResponse,
  DispatchPolicyView,
} from "@you-brain/core/http/types.js";
import type { LaunchModeName, RuntimeModeName } from "@you-brain/protocol";

import type { ChipTone } from "../../components/chip.js";
import type { MessageKey } from "../../i18n/messages.js";
import { formatDateTime, type Language } from "../../lib/format.js";

/** 本机接收派活可选的权限上限档位（不包含 approval-required）。 */
export const DISPATCH_MAX_MODES: readonly LaunchModeName[] = [
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;

export const OUTBOX_SUMMARY_MAX = 120;

export interface DispatchDeviceRowModel {
  id: string;
  name: string;
  isSelf: boolean;
  online: boolean;
  enrolled: boolean;
  acceptsDispatch: boolean;
  projectCount: number;
  maxMode: RuntimeModeName | null;
  t3Ready: boolean | null;
  onlineTone: ChipTone;
}

export interface DispatchSenderOption {
  deviceId: string;
  name: string;
  enrolled: boolean;
  checked: boolean;
  selectable: boolean;
}

export interface FullAccessConfirmState {
  pending: boolean;
}

export type MaxModeTransition =
  | { action: "noop"; state: FullAccessConfirmState }
  | { action: "confirm"; state: FullAccessConfirmState }
  | { action: "apply"; mode: LaunchModeName; state: FullAccessConfirmState };

export interface OutboxStatusMeta {
  labelKey: MessageKey;
  tone: ChipTone;
}

export interface SummaryPreview {
  text: string;
  truncated: boolean;
}

/** 本机优先，其次在线、已入网，最后按名称字典序稳定排序。 */
export function sortDispatchDevices(
  devices: readonly DispatchDeviceView[],
): DispatchDeviceView[] {
  return [...devices].sort((a, b) => {
    if (a.self !== b.self) return a.self ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    if (a.enrolled !== b.enrolled) return a.enrolled ? -1 : 1;
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.id.localeCompare(b.id);
  });
}

export function describeDispatchDevice(device: DispatchDeviceView): DispatchDeviceRowModel {
  const acceptsDispatch = device.dispatch?.enabled === true;
  const projectCount = device.dispatch?.projects.length ?? 0;
  const maxMode = device.dispatch?.maxMode ?? null;
  const t3Ready = device.dispatch ? device.dispatch.t3.ready : null;
  const onlineTone: ChipTone = device.online ? "success" : "neutral";
  return {
    id: device.id,
    name: device.name,
    isSelf: device.self,
    online: device.online,
    enrolled: device.enrolled,
    acceptsDispatch,
    projectCount,
    maxMode,
    t3Ready,
    onlineTone,
  };
}

export function modeLabelKey(mode: RuntimeModeName | null): MessageKey {
  switch (mode) {
    case "auto-accept-edits":
      return "dispatchModeAutoAcceptEdits";
    case "auto":
      return "dispatchModeAuto";
    case "full-access":
      return "dispatchModeFullAccess";
    case "approval-required":
      return "dispatchModeApprovalRequired";
    default:
      return "dispatchModeNone";
  }
}

export function outboxStatusMeta(status: DispatchOutboxEntry["status"]): OutboxStatusMeta {
  switch (status) {
    case "sending":
      return { labelKey: "dispatchStatusSending", tone: "neutral" };
    case "running":
      return { labelKey: "dispatchStatusRunning", tone: "accent" };
    case "waiting":
      return { labelKey: "dispatchStatusWaiting", tone: "warn" };
    case "done":
      return { labelKey: "dispatchStatusDone", tone: "success" };
    case "failed":
      return { labelKey: "dispatchStatusFailed", tone: "danger" };
  }
}

export function initialFullAccessConfirm(): FullAccessConfirmState {
  return { pending: false };
}

/**
 * 切换权限上限的状态机：
 * 切到 `full-access` 时需要页内二次确认（点两次或点「确认开启」），不直接生效。
 */
export function requestMaxModeChange(
  currentMode: RuntimeModeName,
  nextMode: LaunchModeName,
  confirm: FullAccessConfirmState,
): MaxModeTransition {
  if (nextMode === currentMode) {
    return { action: "noop", state: { pending: false } };
  }
  if (nextMode !== "full-access") {
    return { action: "apply", mode: nextMode, state: { pending: false } };
  }
  if (!confirm.pending) {
    return { action: "confirm", state: { pending: true } };
  }
  return { action: "apply", mode: "full-access", state: { pending: false } };
}

export function confirmFullAccess(confirm: FullAccessConfirmState): MaxModeTransition {
  if (!confirm.pending) return { action: "noop", state: confirm };
  return { action: "apply", mode: "full-access", state: { pending: false } };
}

export function cancelFullAccessConfirm(): FullAccessConfirmState {
  return { pending: false };
}

/**
 * 允许的发起设备列表：
 * 已入网设备可选；未入网设备灰显且不可选；已在策略里保存的设备即便暂不在 knownSenders 中也会保留显示。
 */
export function buildSenderOptions(
  knownSenders: readonly DispatchKnownSenderView[],
  policy: DispatchPolicyView,
): DispatchSenderOption[] {
  const allowedIds = new Set(policy.allowedSenders.map((sender) => sender.deviceId));
  const byId = new Map<string, DispatchSenderOption>();

  for (const sender of knownSenders) {
    byId.set(sender.deviceId, {
      deviceId: sender.deviceId,
      name: sender.name,
      enrolled: sender.enrolled,
      checked: sender.enrolled && allowedIds.has(sender.deviceId),
      selectable: sender.enrolled,
    });
  }

  for (const saved of policy.allowedSenders) {
    if (!byId.has(saved.deviceId)) {
      byId.set(saved.deviceId, {
        deviceId: saved.deviceId,
        name: saved.name,
        enrolled: true,
        checked: true,
        selectable: true,
      });
    }
  }

  return [...byId.values()].sort((a, b) => {
    if (a.enrolled !== b.enrolled) return a.enrolled ? -1 : 1;
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.deviceId.localeCompare(b.deviceId);
  });
}

export function toggleAllowedProject(
  current: readonly string[],
  projectId: string,
  checked: boolean,
): string[] {
  const next = new Set(current);
  if (checked) next.add(projectId);
  else next.delete(projectId);
  return [...next];
}

/** 未入网的设备不能被加入 allowedSenders。 */
export function toggleAllowedSender(
  current: readonly string[],
  sender: Pick<DispatchKnownSenderView, "deviceId" | "enrolled">,
  checked: boolean,
): string[] {
  if (checked && !sender.enrolled) return [...current];
  const next = new Set(current);
  if (checked) next.add(sender.deviceId);
  else next.delete(sender.deviceId);
  return [...next];
}

export function applyOptimisticPolicyPatch(
  current: DispatchPolicyResponse,
  patch: DispatchPolicyPutBody,
): DispatchPolicyResponse {
  const senderLookup = new Map<string, { name: string; publicKey: string }>();
  for (const saved of current.policy.allowedSenders) {
    senderLookup.set(saved.deviceId, { name: saved.name, publicKey: saved.publicKey });
  }
  for (const known of current.knownSenders) {
    if (!senderLookup.has(known.deviceId)) {
      senderLookup.set(known.deviceId, {
        name: known.name,
        publicKey: known.publicKey ?? "",
      });
    }
  }

  const nextSenders =
    patch.allowedSenders !== undefined
      ? patch.allowedSenders.map((deviceId) => {
          const info = senderLookup.get(deviceId);
          return {
            deviceId,
            name: info?.name ?? deviceId,
            publicKey: info?.publicKey ?? "",
          };
        })
      : current.policy.allowedSenders;

  return {
    ...current,
    policy: {
      ...current.policy,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.notify !== undefined ? { notify: patch.notify } : {}),
      ...(patch.viewT3 !== undefined ? { viewT3: patch.viewT3 } : {}),
      ...(patch.maxMode !== undefined ? { maxMode: patch.maxMode } : {}),
      ...(patch.allowedProjects !== undefined
        ? { allowedProjects: [...patch.allowedProjects] }
        : {}),
      allowedSenders: nextSenders,
    },
  };
}

/** 乐观更新并在保存失败时回滚到修改前的完整策略状态。 */
export async function commitPolicyPatch(options: {
  current: DispatchPolicyResponse;
  patch: DispatchPolicyPutBody;
  save: (body: DispatchPolicyPutBody) => Promise<DispatchPolicyResponse>;
  onOptimistic: (next: DispatchPolicyResponse) => void;
  onCommit: (saved: DispatchPolicyResponse) => void;
  onRollback: (previous: DispatchPolicyResponse, errorMessage: string) => void;
  fallbackError: string;
}): Promise<boolean> {
  const optimistic = applyOptimisticPolicyPatch(options.current, options.patch);
  options.onOptimistic(optimistic);
  try {
    const saved = await options.save(options.patch);
    options.onCommit(saved);
    return true;
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim() !== ""
        ? error.message
        : options.fallbackError;
    options.onRollback(options.current, message);
    return false;
  }
}

/** 按 updatedAt 倒序排列（最新在前），相同则按 createdAt 倒序、dispatchId 升序。 */
export function sortOutboxEntries(
  entries: readonly DispatchOutboxEntry[],
): DispatchOutboxEntry[] {
  return [...entries].sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.dispatchId.localeCompare(b.dispatchId);
  });
}

export function mergeOutboxEntry(
  entries: readonly DispatchOutboxEntry[],
  updated: DispatchOutboxEntry,
): DispatchOutboxEntry[] {
  const filtered = entries.filter((item) => item.dispatchId !== updated.dispatchId);
  filtered.push(updated);
  return sortOutboxEntries(filtered);
}

/** 折叠空白并按 Unicode 码点安全截断到 maxChars（默认 120 字）。 */
export function truncateSummary(
  summary: string | undefined,
  maxChars: number = OUTBOX_SUMMARY_MAX,
): SummaryPreview {
  const normalized = (summary ?? "").replace(/\s+/gu, " ").trim();
  if (normalized === "") return { text: "", truncated: false };
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) return { text: normalized, truncated: false };
  return {
    text: `${chars.slice(0, maxChars).join("")}…`,
    truncated: true,
  };
}

export function formatOutboxTime(
  timestampMs: number,
  language: Language,
  timeZone?: string,
): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "—";
  return formatDateTime(new Date(timestampMs).toISOString(), language, timeZone);
}
