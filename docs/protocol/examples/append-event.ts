import { createEvent, eventLogPath, serializeEventLine } from "@you-brain/protocol";

const deviceId = "44444444-4444-4444-8444-444444444444";
const event = createEvent({
  type: "topic.created",
  device: deviceId,
  seq: 1,
  ts: "2026-10-18T03:00:00.000Z",
  id: "01J00000000000000000000000",
  data: { topicId: "topic-1", name: "命名", aliases: [] },
});
const line = serializeEventLine(event);
if (!line.endsWith("\n") || line.slice(0, -1).includes("\n")) {
  throw new Error("serializeEventLine 必须是一行 JSON 加换行");
}

console.log(eventLogPath(deviceId, "2026-10-18"));
process.stdout.write(line);
