import { isLlmAbortError } from "../llm/errors.js";
import type { ConsolidationContext, ConsolidationStep } from "./steps.js";

export const DEFAULT_CONSOLIDATION_STEP_BUDGET_MS = 20 * 60 * 1000;

export interface ConsolidationStepResult {
  id: string;
  ok: boolean;
  error?: string;
}

export interface ConsolidationRunResult {
  day: string;
  ok: boolean;
  aborted?: boolean;
  steps: ConsolidationStepResult[];
  warnings: string[];
}

export async function runConsolidation(
  input: Omit<ConsolidationContext, "warnings"> & {
    steps: readonly ConsolidationStep[];
    isFinalDay?: boolean;
    stepBudgetMs?: number;
  },
): Promise<ConsolidationRunResult> {
  const isFinalDay = input.isFinalDay ?? true;
  const stepBudgetMs = input.stepBudgetMs ?? DEFAULT_CONSOLIDATION_STEP_BUDGET_MS;
  const externalSignal = input.signal;
  const warnings: string[] = [];
  const failed = new Set<string>();
  const steps: ConsolidationStepResult[] = [];

  for (const step of input.steps) {
    if (externalSignal?.aborted) {
      return { day: input.day, ok: false, aborted: true, steps, warnings };
    }
    if (step.finalDayOnly && !isFinalDay) continue;
    if (step.dependsOn?.some((id) => failed.has(id))) {
      const error = "依赖步骤失败";
      warnings.push(`${step.id}：${error}`);
      steps.push({ id: step.id, ok: false, error });
      if (!step.advisory) failed.add(step.id);
      continue;
    }

    const budgetController = new AbortController();
    let timedOut = false;
    const budgetTimer = setTimeout(() => {
      timedOut = true;
      budgetController.abort();
    }, stepBudgetMs);

    const stepSignal = externalSignal
      ? AbortSignal.any([externalSignal, budgetController.signal])
      : budgetController.signal;
    const ctx: ConsolidationContext = { ...input, warnings, signal: stepSignal };

    try {
      await step.run(ctx);
      if (externalSignal?.aborted) {
        return { day: input.day, ok: false, aborted: true, steps, warnings };
      }
      steps.push({ id: step.id, ok: true });
    } catch (error) {
      if (externalSignal?.aborted) {
        return { day: input.day, ok: false, aborted: true, steps, warnings };
      }
      const message =
        timedOut && isLlmAbortError(error)
          ? "步骤执行超时"
          : error instanceof Error
            ? error.message.trim()
            : "";
      const short = clip(message === "" ? "步骤失败" : message);
      warnings.push(`${step.id}：${short}`);
      steps.push({ id: step.id, ok: false, error: short });
      if (!step.advisory) failed.add(step.id);
    } finally {
      clearTimeout(budgetTimer);
    }
  }
  return { day: input.day, ok: failed.size === 0, steps, warnings };
}

function clip(message: string): string {
  const chars = Array.from(message);
  if (chars.length <= 80) return chars.join("");
  return `${chars.slice(0, 79).join("")}…`;
}
