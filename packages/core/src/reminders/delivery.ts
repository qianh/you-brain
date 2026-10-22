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
  const localMs = input.lastActivityAt === null ? null : Date.parse(input.lastActivityAt);
  if (localMs === null || Number.isNaN(localMs) || Number.isNaN(nowMs) || !withinWindow(localMs, nowMs)) {
    return { notify: false, reason: "inactive" };
  }
  const beaten = input.devices.some((device) => {
    if (device.deviceId === input.deviceId) return false;
    const otherMs = Date.parse(device.lastActiveAt);
    if (Number.isNaN(otherMs) || !withinWindow(otherMs, nowMs)) return false;
    if (otherMs > localMs) return true;
    return otherMs === localMs && device.deviceId < input.deviceId;
  });
  if (beaten) return { notify: false, reason: "other-device" };
  return { notify: true, reason: "ok" };
}

/** True when `at` is inside the notification window around `nowMs`. */
export function activityIsRecent(at: string | null, nowMs: number): boolean {
  if (at === null) return false;
  const ms = Date.parse(at);
  if (Number.isNaN(ms) || Number.isNaN(nowMs)) return false;
  return withinWindow(ms, nowMs);
}

function withinWindow(atMs: number, nowMs: number): boolean {
  const age = nowMs - atMs;
  return age <= ACTIVITY_WINDOW_MS && age >= -ACTIVITY_WINDOW_MS;
}
