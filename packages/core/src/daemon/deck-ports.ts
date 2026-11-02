import type {
  DeckCapabilityPort,
} from "../deck/index.js";
import type {
  PortraitResponse,
  SearchRequest,
  SearchResponse,
  TopicDetail,
  TopicListItem,
  TopicsQuery,
  TopicsResponse,
  TodayResponse,
  NotionSearchView,
} from "../http/types.js";

function clipText(text: string, cap = 600): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}…`;
}

function timeOfDay(iso: string | null): string {
  if (iso === null) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Date(at).toISOString().slice(11, 16);
}

function topicLine(topic: TopicListItem): string {
  const summary = clipText(topic.summary.replace(/\n+/gu, " "), 220);
  return `- ${topic.name}（${topic.status}）[${topic.topicId}]：${summary}`;
}

function renderToday(response: TodayResponse): string {
  if (response.sessions.length === 0) return `今天（${response.date}）没有会话。`;
  const lines = response.sessions.map((session) => {
    const topic = session.topicName === null ? "" : `［${session.topicName}］`;
    const at = timeOfDay(session.updatedAt);
    const summary = clipText(session.summary.replace(/\n+/gu, " "), 200);
    return `- ${topic}${session.title || "（未提炼）"}${at === "" ? "" : ` ${at}`}${summary === "" ? "" : `：${summary}`}`;
  });
  return `今天（${response.date}，${response.timeZone}）共 ${response.sessions.length} 个会话：\n${lines.join("\n")}`;
}

function renderTopics(response: TopicsResponse): string {
  if (response.topics.length === 0) return "（话题册为空）";
  return response.topics.map(topicLine).join("\n");
}

function renderTopicDetail(detail: TopicDetail): string {
  const parts: string[] = [];
  parts.push(`# ${detail.name}（${detail.status}，${detail.zone === "active" ? "活跃区" : "历史区"}）[${detail.topicId}]`);
  if (detail.summary.trim() !== "") parts.push(`概要：${detail.summary}`);
  if (detail.nextStep.trim() !== "") parts.push(`下一步：${detail.nextStep}`);
  if (detail.conclusions.length > 0) {
    parts.push(
      `结论：\n${detail.conclusions.map((item) => `- ${clipText(item.text, 300)}`).join("\n")}`,
    );
  }
  if (detail.todos.length > 0) {
    parts.push(
      `待办：\n${detail.todos.map((item) => `- [${item.status}] ${clipText(item.text, 200)}`).join("\n")}`,
    );
  }
  if (detail.sessions.length > 0) {
    parts.push(`相关会话：${detail.sessions.length} 个`);
  }
  return parts.join("\n\n");
}

function renderSearch(response: SearchResponse): string {
  if (response.results.length === 0) return "（没有匹配的会话）";
  const lines = response.results.map((hit) => {
    return `- [${hit.source}] ${clipText(hit.excerpt.replace(/\n+/gu, " "), 260)}（${hit.startedAt.slice(0, 10)}，会话 ${hit.conversationId.slice(0, 8)}）`;
  });
  return `搜索到 ${response.results.length} 条：\n${lines.join("\n")}`;
}

function renderPortrait(response: PortraitResponse | null, variant: string): string {
  if (response === null) return `（数字分身变体 ${variant} 不存在）`;
  return `数字分身 ${response.variant}：\n${clipText(response.content, 8_000)}`;
}

function renderKnowledge(view: NotionSearchView): string {
  if (view.hits.length === 0) return "（知识库没有匹配页面）";
  return `知识库命中 ${view.hits.length} 条：\n${view.hits
    .map((hit) => `- ${hit.title}：${clipText(hit.excerpt.replace(/\n+/gu, " "), 200)}`)
    .join("\n")}`;
}

/** 把 daemon 的读取端口渲染成指挥台主控用的文本能力。 */
export function buildDeckCapabilityPort(input: {
  today(): Promise<TodayResponse>;
  topics(query: TopicsQuery): Promise<TopicsResponse>;
  topic(id: string): Promise<TopicDetail | null>;
  search(query: SearchRequest): Promise<SearchResponse>;
  portrait(variant: string): Promise<PortraitResponse | null>;
  knowledgeSearch(query: string, limit?: number): Promise<NotionSearchView>;
}): DeckCapabilityPort {
  return {
    today: async () => renderToday(await input.today()),
    activeTopics: async () => renderTopics(await input.topics({ zone: "active" })),
    topic: async (id) => {
      const detail = await input.topic(id);
      return detail === null ? `（话题 ${id} 不存在）` : renderTopicDetail(detail);
    },
    search: async (query) => renderSearch(await input.search({ query, limit: 8 })),
    portrait: async (variant) => renderPortrait(await input.portrait(variant), variant),
    knowledge: async (query) => renderKnowledge(await input.knowledgeSearch(query, 8)),
  };
}
