export const zh = {
  panelOpenMain: "在主窗口打开",
  panelTodayLine: "今天 · {count} 个会话",
  panelOpenToday: "打开",
  panelMoreSessions: "还有 {count} 个会话",
  panelTopicsLabel: "话题",
  panelMoreWarnings: "还有 {count} 项",
  panelEmptyBody: "打开 AI 工具开始使用",
  panelLoadError: "没能读取面板数据",
} as const;

export const en: { [K in keyof typeof zh]: string } = {
  panelOpenMain: "Open in main window",
  panelTodayLine: "Today · {count} sessions",
  panelOpenToday: "Open",
  panelMoreSessions: "{count} more sessions",
  panelTopicsLabel: "Topics",
  panelMoreWarnings: "{count} more",
  panelEmptyBody: "Open an AI tool to get started",
  panelLoadError: "Couldn’t load the panel",
};
