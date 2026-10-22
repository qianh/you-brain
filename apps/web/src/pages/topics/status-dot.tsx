import type { TopicStatus } from "@you-brain/protocol";

import { statusDot } from "./logic.js";

export function StatusDot({ status }: { status: TopicStatus }) {
  return <i className={`topics-dot ${statusDot(status)}`} aria-hidden="true" />;
}
