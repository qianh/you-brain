import { z } from "zod";

/** 指挥台一轮对话。`event` 是系统动作记录（派活、失败、登记任务），不进正文管线。 */
export type DeckTurnRole = "user" | "assistant" | "event";

export interface DeckTurn {
  id: string;
  role: DeckTurnRole;
  text: string;
  at: string;
}

export interface DeckConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 周期任务的执行记录会话带此标记。 */
  taskId?: string;
  turns: DeckTurn[];
}

export const EXECUTOR_KINDS = ["cli-agent", "model", "capability", "gui-app"] as const;
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];

export interface ExecutorRef {
  kind: ExecutorKind;
  id: string;
}

export interface DeckScheduleDaily {
  kind: "daily";
  /** 本地时区 HH:MM。 */
  time: string;
}

export interface DeckScheduleInterval {
  kind: "interval";
  minutes: number;
}

export type DeckSchedule = DeckScheduleDaily | DeckScheduleInterval;

export const DeckScheduleSchema = z.union([
  z.object({ kind: z.literal("daily"), time: z.string().regex(/^\d{2}:\d{2}$/u, "时间用 HH:MM") }),
  z.object({
    kind: z.literal("interval"),
    minutes: z.number().int().min(5, "最短 5 分钟").max(60 * 24 * 30, "最长 30 天"),
  }),
]);

export interface DeckTask {
  id: string;
  title: string;
  prompt: string;
  executor: ExecutorRef;
  schedule: DeckSchedule;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
}

export interface DeckTaskInput {
  title: string;
  prompt: string;
  executor: ExecutorRef;
  schedule: DeckSchedule;
  enabled?: boolean;
}

/** 一次派活的执行状态（内存态；落库痕迹在会话的 event/assistant 轮里）。 */
export interface DeckJobView {
  id: string;
  conversationId: string;
  title: string;
  executor: ExecutorRef;
  status: "running" | "ok" | "error";
  startedAt: string;
  error?: string;
}

/** 指挥台本地配置（`<dataDir>/deck/config.json`，不进 Drive）。 */
export interface DeckConfig {
  /** 主控 CLI 覆盖；缺省时自动探测。 */
  masterProvider?: string;
  masterModel?: string;
}

export const ExecutorRefSchema = z.object({
  kind: z.enum(EXECUTOR_KINDS),
  id: z.string().min(1),
});
