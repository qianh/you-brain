export const TOPIC_SUMMARY_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "nextStep"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 200 },
    nextStep: { type: "string", maxLength: 80 },
  },
};

export const TWIN_CLAIMS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["layer", "project", "confidence", "text"],
        properties: {
          layer: { type: "string", enum: ["persona", "coding", "project"] },
          project: { type: "string" },
          confidence: { type: "string", enum: ["high", "low"] },
          text: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

export const TWIN_EDITS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["bump", "changelog", "edits"],
  properties: {
    bump: { type: "string", enum: ["patch", "minor", "major"] },
    changelog: { type: "array", maxItems: 8, items: { type: "string", minLength: 1 } },
    edits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["layer", "heading", "text"],
        properties: {
          layer: { type: "string", enum: ["full", "coding", "projects"] },
          heading: { type: "string", minLength: 1 },
          text: { type: "string" },
        },
      },
    },
  },
};

export const TWIN_PROBES_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["probes"],
  properties: {
    probes: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["layer", "situation", "expect"],
        properties: {
          layer: { type: "string", enum: ["persona", "coding"] },
          situation: { type: "string", minLength: 1 },
          expect: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

export const TWIN_EVAL_ANSWERS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["answers"],
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "answer"],
        properties: {
          id: { type: "string", minLength: 1 },
          answer: { type: "string" },
        },
      },
    },
  },
};

export const TWIN_EVAL_JUDGE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "pass"],
        properties: {
          id: { type: "string", minLength: 1 },
          pass: { type: "boolean" },
        },
      },
    },
  },
};

export const TWIN_MONTHLY_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["notes"],
  properties: {
    notes: {
      type: "array",
      maxItems: 6,
      items: { type: "string", minLength: 1 },
    },
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
