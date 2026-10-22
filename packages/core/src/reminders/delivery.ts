import type { ReminderDelivery } from "../http/types.js";

/** No recorded activity. Heartbeats must not invent a fresher timestamp. */
export const ACTIVITY_EPOCH = "1970-01-01T00:00:00.000Z";

/** A device is in use while its activity is at most this far from now. */
export const ACTIVITY_WINDOW_MS = 10 * 60 * 1000;

export interface DeliveryDevice {
  deviceId: string;
  lastActiveAt: string;
}

export interface DeliveryInput {
  notifications: boolean;
  deviceId: string;
  /** In-memory activity on this device. `null` means nothing has been reported. */
  lastActivityAt: string | null;
  devices: readonly DeliveryDevice[];
  now: string;
}

/**
 * Exactly one device notifies. A tie on the same instant goes to the
 * lexicographically smaller deviceId.
 */
export function decideDelivery(input: DeliveryInput): ReminderDelivery {
  if (!input.notifications) return { notify: false, reason: "disabled" };
  const nowMs = Date.parse(input.now);
  const localMs = recordedActivityMs(input.lastActivityAt);
  if (localMs === null || Number.isNaN(nowMs) || !withinWindow(localMs, nowMs)) {
    return { notify: false, reason: "inactive" };
  }
  const beaten = input.devices.some((device) => {
    if (device.deviceId === input.deviceId) return false;
    const otherMs = recordedActivityMs(device.lastActiveAt);
    if (otherMs === null || !withinWindow(otherMs, nowMs)) return false;
    if (otherMs > localMs) return true;
    return otherMs === localMs && device.deviceId < input.deviceId;
  });
  if (beaten) return { notify: false, reason: "other-device" };
  return { notify: true, reason: "ok" };
}

/** True when `at` is inside the notification window around `nowMs`. */
export function activityIsRecent(at: string | null, nowMs: number): boolean {
  const ms = recordedActivityMs(at);
  if (ms === null || Number.isNaN(nowMs)) return false;
  return withinWindow(ms, nowMs);
}

/** Epoch and unreadable timestamps are not activity, even when `now` is the epoch. */
function recordedActivityMs(at: string | null): number | null {
  if (at === null) return null;
  const ms = Date.parse(at);
  if (Number.isNaN(ms) || ms <= Date.parse(ACTIVITY_EPOCH)) return null;
  return ms;
}

function withinWindow(atMs: number, nowMs: number): boolean {
  const age = nowMs - atMs;
  return age <= ACTIVITY_WINDOW_MS && age >= -ACTIVITY_WINDOW_MS;
}
