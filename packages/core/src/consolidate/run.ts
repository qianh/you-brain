import type { ConsolidationContext, ConsolidationStep } from "./steps.js";

export interface ConsolidationStepResult {
  id: string;
  ok: boolean;
  error?: string;
}

export interface ConsolidationRunResult {
  day: string;
  ok: boolean;
  steps: ConsolidationStepResult[];
  warnings: string[];
}

export async function runConsolidation(
  input: Omit<ConsolidationContext, "warnings"> & { steps: readonly ConsolidationStep[] },
): Promise<ConsolidationRunResult> {
  const warnings: string[] = [];
  const failed = new Set<string>();
  const steps: ConsolidationStepResult[] = [];
  const ctx: ConsolidationContext = { ...input, warnings };
  for (const step of input.steps) {
    if (step.dependsOn?.some((id) => failed.has(id))) {
      const error = "依赖步骤失败";
      warnings.push(`${step.id}：${error}`);
      steps.push({ id: step.id, ok: false, error });
      failed.add(step.id);
      continue;
    }
    try {
      await step.run(ctx);
      steps.push({ id: step.id, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message.trim() : "";
      const short = clip(message === "" ? "步骤失败" : message);
      warnings.push(short);
      steps.push({ id: step.id, ok: false, error: short });
      failed.add(step.id);
    }
  }
  return { day: input.day, ok: failed.size === 0, steps, warnings };
}

function clip(message: string): string {
  const chars = Array.from(message);
  if (chars.length <= 80) return chars.join("");
  return `${chars.slice(0, 79).join("")}…`;
}
