export const TOPIC_SUMMARY_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "nextStep"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 200 },
    nextStep: { type: "string", maxLength: 80 },
  },
};

export const PORTRAIT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["changed", "portrait"],
  properties: {
    changed: { type: "boolean" },
    portrait: { type: "string" },
  },
};

export const MERGE_SUGGESTIONS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["pairs"],
  properties: {
    pairs: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fromTopicId", "intoTopicId", "reason"],
        properties: {
          fromTopicId: { type: "string", minLength: 1 },
          intoTopicId: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1, maxLength: 80 },
        },
      },
    },
  },
};
