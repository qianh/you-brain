export {
  executeConsolidation,
  emptyConsolidationState,
  ConsolidationRejected,
  consolidationRejectMessage,
  type ConsolidationExecution,
  type ConsolidationLastRun,
  type ConsolidationRuntime,
  type ConsolidationState,
} from "./execute.js";
export {
  ConsolidateLeaseSchema,
  mergeConsolidateLease,
  parseConsolidateLease,
  readConsolidateLease,
  writeConsolidateLease,
  type ConsolidateLease,
} from "./lease.js";
export { normalizeMergePairs, parseTopicRewrite, type MergePair, type TopicRewrite } from "./normalize.js";
export {
  buildMergeSuggestionsPrompt,
  buildTopicSummaryPrompt,
  MERGE_SUGGESTIONS_SYSTEM_PROMPT,
  TOPIC_SUMMARY_SYSTEM_PROMPT,
} from "./prompt.js";
export { runConsolidation, type ConsolidationRunResult, type ConsolidationStepResult } from "./run.js";
export {
  BACKOFF_INITIAL_MS,
  BACKOFF_MAX_MS,
  MAX_CATCH_UP_DAYS,
  consolidationBlock,
  consolidationTimeDue,
  instantOnLocalDay,
  localDayKey,
  nextBackoffMs,
  planConsolidationDays,
  shiftDateKey,
  type ConsolidationBlock,
} from "./schedule.js";
export { MERGE_SUGGESTIONS_JSON_SCHEMA, TOPIC_SUMMARY_JSON_SCHEMA } from "./schema.js";
export {
  MERGE_TOPIC_LIMIT,
  RECENT_SESSIONS,
  recentTopicSessions,
  selectChangedTopics,
  selectMergeCandidates,
  type ChangedTopic,
} from "./select.js";
export {
  consolidationSteps,
  mergeSuggestionsStep,
  registerConsolidationStep,
  resetConsolidationSteps,
  topicSummariesStep,
  type ConsolidationContext,
  type ConsolidationStep,
} from "./steps.js";
export {
  MERGE_SUGGESTIONS_CURSOR,
  mergeSuggestionLines,
  parseMergeSuggestions,
  type MergeSuggestionLine,
  type MergeSuggestions,
} from "./suggestions.js";
export { collapseText, sameText, textUnits } from "./text.js";
