/**
 * daemon 能力执行者：指挥台主控可以直接派活的内部查询能力。
 * 端口由 daemon 提供（实现把数据渲染成文本），deck 模块只认字符串进出。
 */
export interface DeckCapabilityPort {
  /** 今日视图摘要。 */
  today(): Promise<string>;
  /** 活跃话题列表。 */
  activeTopics(): Promise<string>;
  /** 单个话题详情。 */
  topic(id: string): Promise<string>;
  /** 历史会话语义+关键词搜索。 */
  search(query: string): Promise<string>;
  /** 数字分身变体内容。 */
  portrait(variant: string): Promise<string>;
  /** 知识库（Notion）搜索。 */
  knowledge(query: string): Promise<string>;
}

export interface DeckCapability {
  id: string;
  title: string;
  /** 给主控看的一句话：input 怎么填。 */
  hint: string;
  run(input: string): Promise<string>;
}

export function deckCapabilities(port: DeckCapabilityPort): DeckCapability[] {
  return [
    {
      id: "search",
      title: "会话搜索",
      hint: "input 是搜索词（语义+关键词）",
      run: (input) => port.search(input.trim()),
    },
    {
      id: "today",
      title: "今日视图",
      hint: "忽略 input，返回今天所有会话与提炼",
      run: () => port.today(),
    },
    {
      id: "topics",
      title: "话题册",
      hint: "忽略 input，返回活跃话题列表",
      run: () => port.activeTopics(),
    },
    {
      id: "topic",
      title: "话题详情",
      hint: "input 是话题 ID（先派 topics 拿 ID）",
      run: (input) => port.topic(input.trim()),
    },
    {
      id: "portrait",
      title: "数字分身",
      hint: "input 是变体（full/coding/projects，留空取 full）",
      run: (input) => port.portrait(input.trim() === "" ? "full" : input.trim()),
    },
    {
      id: "knowledge",
      title: "知识库搜索",
      hint: "input 是搜索词",
      run: (input) => port.knowledge(input.trim()),
    },
  ];
}
