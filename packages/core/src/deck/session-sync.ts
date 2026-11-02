import { renderSessionMarkdown } from "../capture/normalize.js";
import { applyCaptureRedaction } from "../capture/redact.js";
import type { NormalizedSession } from "../domain/session.js";
import type { UploadableSession } from "../upload/types.js";
import type { DeckConversation } from "./types.js";

/** 指挥台会话的采集来源 id。程序内直产，不走磁盘扫描，因此不在 CAPTURE_SOURCE_IDS 里。 */
export const DECK_SESSION_SOURCE = "deck";

export function deckSessionFromConversation(
  conversation: DeckConversation,
  device: string,
): NormalizedSession {
  const turns = conversation.turns
    .filter((turn) => turn.role === "user" || turn.role === "assistant")
    .map((turn) => ({
      role: turn.role === "user" ? ("user" as const) : ("assistant" as const),
      text: turn.text,
      images: [],
    }));
  const startedAt = conversation.createdAt;
  const updatedAt = conversation.updatedAt >= startedAt ? conversation.updatedAt : startedAt;
  return {
    source: DECK_SESSION_SOURCE,
    conversationId: conversation.id,
    device,
    startedAt,
    updatedAt,
    // 管线要求至少一轮；纯 event 的极端情况给一条占位，避免渲染失败。
    turns:
      turns.length > 0
        ? turns
        : [{ role: "user", text: conversation.title, images: [] }],
    sourcePath: `deck://${conversation.id}`,
    warnings: [],
  };
}

/**
 * 把指挥台对话落成会话原文（原地更新：一个对话一个 Drive 文件），
 * 之后 15 秒内的提炼回填会自动处理它——派活的决策与产出自动进话题册和分身。
 */
export async function uploadDeckSession(
  upload: (session: UploadableSession) => Promise<unknown>,
  conversation: DeckConversation,
  device: string,
): Promise<void> {
  const session = deckSessionFromConversation(conversation, device);
  const redacted = applyCaptureRedaction(session, { redact: true, redaction: {} });
  const rendered = renderSessionMarkdown(redacted.session, {
    redactionVersion: redacted.version,
    redactionCount: redacted.count,
    imageReferences: new Map(),
  });
  await upload({
    source: session.source,
    conversationId: session.conversationId,
    device: session.device,
    title: conversation.title,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    messageCount: session.turns.length,
    markdown: rendered.markdown,
    contentSha256: rendered.contentSha256,
  });
}
