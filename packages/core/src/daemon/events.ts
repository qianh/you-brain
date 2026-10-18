import type { Event } from "@you-brain/protocol";

import type { EventLog } from "../sync/event-log.js";
import type { ProtocolSync } from "../sync/service.js";

/** Re-append refine events so the log assigns fresh ids. Topic ids inside `data` stay. */
export async function appendCopied(sync: ProtocolSync, event: Event): Promise<void> {
  switch (event.type) {
    case "session.refined":
      await sync.append(event.type, event.data);
      return;
    case "topic.created":
      await sync.append(event.type, event.data);
      return;
    case "topic.assigned":
      await sync.append(event.type, event.data);
      return;
    case "topic.unassigned":
      await sync.append(event.type, event.data);
      return;
    case "topic.renamed":
      await sync.append(event.type, event.data);
      return;
    case "topic.status_changed":
      await sync.append(event.type, event.data);
      return;
    case "topic.merged":
      await sync.append(event.type, event.data);
      return;
    case "topic.summary_rewritten":
      await sync.append(event.type, event.data);
      return;
    case "conclusion.added":
      await sync.append(event.type, event.data);
      return;
    case "todo.added":
      await sync.append(event.type, event.data);
      return;
    case "todo.status_changed":
      await sync.append(event.type, event.data);
      return;
    case "portrait.correction":
      await sync.append(event.type, event.data);
      return;
    case "portrait.correction_applied":
      await sync.append(event.type, event.data);
      return;
    case "reminder.issued":
      await sync.append(event.type, event.data);
      return;
    case "reminder.action":
      await sync.append(event.type, event.data);
      return;
    default: {
      const unreachable: never = event;
      throw new Error(`未知事件 ${(unreachable as Event).type}`);
    }
  }
}

export function allocateCopied(log: EventLog, event: Event): Event {
  switch (event.type) {
    case "session.refined":
      return log.allocate(event.type, event.data);
    case "topic.created":
      return log.allocate(event.type, event.data);
    case "topic.assigned":
      return log.allocate(event.type, event.data);
    case "topic.unassigned":
      return log.allocate(event.type, event.data);
    case "topic.renamed":
      return log.allocate(event.type, event.data);
    case "topic.status_changed":
      return log.allocate(event.type, event.data);
    case "topic.merged":
      return log.allocate(event.type, event.data);
    case "topic.summary_rewritten":
      return log.allocate(event.type, event.data);
    case "conclusion.added":
      return log.allocate(event.type, event.data);
    case "todo.added":
      return log.allocate(event.type, event.data);
    case "todo.status_changed":
      return log.allocate(event.type, event.data);
    case "portrait.correction":
      return log.allocate(event.type, event.data);
    case "portrait.correction_applied":
      return log.allocate(event.type, event.data);
    case "reminder.issued":
      return log.allocate(event.type, event.data);
    case "reminder.action":
      return log.allocate(event.type, event.data);
    default: {
      const unreachable: never = event;
      throw new Error(`未知事件 ${(unreachable as Event).type}`);
    }
  }
}
