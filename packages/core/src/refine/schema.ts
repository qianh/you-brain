/** Strict object schema sent as response_format or Anthropic tool input. */
export const REFINE_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "summary",
    "topic",
    "conclusions_added",
    "todos_added",
    "todos_completed",
  ],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    topic: {
      type: "object",
      additionalProperties: false,
      required: ["action", "topicId", "name", "aliases"],
      properties: {
        action: { type: "string", enum: ["assign", "create"] },
        topicId: { type: "string" },
        name: { type: "string" },
        aliases: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    },
    conclusions_added: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    todos_added: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "confidence"],
        properties: {
          text: { type: "string", minLength: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    todos_completed: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
  },
};
