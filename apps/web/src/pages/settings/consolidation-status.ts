export type ConsolidateGate = "ready" | "off" | "not-main";

export function consolidateGate(input: {
  enabled: boolean;
  deviceId: string | null;
  mainDevice: string | null;
}): ConsolidateGate {
  if (!input.enabled) return "off";
  if (input.deviceId === null || input.deviceId === "" || input.deviceId !== input.mainDevice) {
    return "not-main";
  }
  return "ready";
}

export function formatConsolidationRun(
  run: { day: string; ok: boolean; error?: string },
  labels: { succeeded: string; failed: string },
): string {
  if (run.ok) return `${run.day} ${labels.succeeded}`;
  const error = run.error?.trim() ?? "";
  if (error === "") return `${run.day} ${labels.failed}`;
  return `${run.day} ${labels.failed}（${error}）`;
}
