import { createVirtualDeviceRecord, deviceRecordPath } from "@you-brain/protocol";

const record = createVirtualDeviceRecord({
  deviceId: "44444444-4444-4444-8444-444444444444",
  displayName: "沉淀机器人",
  capabilities: ["refine", "consolidate"],
  now: new Date("2026-10-18T03:00:00.000Z"),
});

console.log(deviceRecordPath(record.deviceId));
console.log(JSON.stringify(record));
