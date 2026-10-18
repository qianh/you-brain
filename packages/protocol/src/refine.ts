import { z } from "zod";

export const REFINE_TOPIC_ACTIONS = ["assign", "create"] as const;

export const RefineTopicSchema = z.object({
  action: z.enum(REFINE_TOPIC_ACTIONS),
  topicId: z.string(),
  name: z.string(),
  aliases: z.array(z.string().min(1)),
});

export const RefineTodoSchema = z.object({
  text: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const RefineOutputSchema = z.object({
  title: z.string(),
  summary: z.string(),
  topic: RefineTopicSchema,
  conclusions_added: z.array(z.string().min(1)),
  todos_added: z.array(RefineTodoSchema),
  todos_completed: z.array(z.string().min(1)),
});

export type RefineTopic = z.infer<typeof RefineTopicSchema>;
export type RefineTodo = z.infer<typeof RefineTodoSchema>;
export type RefineOutput = z.infer<typeof RefineOutputSchema>;

export function parseRefineOutput(input: unknown): RefineOutput {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  return RefineOutputSchema.parse(value);
}
