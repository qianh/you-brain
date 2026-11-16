export const zh = {
  panelOpenMain: "在主窗口打开",
  panelQuotaTitle: "额度",
  panelQuotaStale: "{minutes} 分钟前",
  panelNothingNow: "暂时没有提醒",
  panelLoadError: "没能读取面板数据",
  panelGuideDone: "已完成 {done}/{total} · {names}",
  panelGuideDrive: "Google Drive",
  panelGuideModel: "模型",
  panelGuideCapture: "采集",
} as const;

export const en: { [K in keyof typeof zh]: string } = {
  panelOpenMain: "Open in main window",
  panelQuotaTitle: "Usage",
  panelQuotaStale: "{minutes} min ago",
  panelNothingNow: "No reminders right now",
  panelLoadError: "Couldn’t load the panel",
  panelGuideDone: "{done}/{total} done · {names}",
  panelGuideDrive: "Google Drive",
  panelGuideModel: "Model",
  panelGuideCapture: "Capture",
};
