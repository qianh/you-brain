export const zh = {
  dshDeckStarting: "正在启动 DeepSeek Harness…",
  dshDeckStartingHint: "首次启动需要几秒。",
  dshDeckError: "DeepSeek Harness 没有启动：{message}",
  dshDeckRetry: "重试",
  dshDeckFrameTitle: "DeepSeek Harness 指挥台",
  dshDeckUnavailable: "后台没有提供指挥台服务",
};

export const en: { [K in keyof typeof zh]: string } = {
  dshDeckStarting: "Starting DeepSeek Harness…",
  dshDeckStartingHint: "The first start takes a few seconds.",
  dshDeckError: "DeepSeek Harness did not start: {message}",
  dshDeckRetry: "Retry",
  dshDeckFrameTitle: "DeepSeek Harness command deck",
  dshDeckUnavailable: "The daemon does not provide the command deck service",
};
