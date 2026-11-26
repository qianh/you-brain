import { describe, expect, test } from "bun:test";
import {
  TASK_CLASSIFY_JSON_SCHEMA,
  createLlmTaskClassifier,
  parseTaskRequirementKind,
} from "../../src/tasks/classify.js";
import type { LlmCompleteRequest } from "../../src/llm/types.js";

describe("TODO requirement classifier", () => {
  test("parses valid JSON kinds and falls back to uncertain on malformed outputs", () => {
    expect(parseTaskRequirementKind('{"kind":"requirement"}')).toBe("requirement");
    expect(parseTaskRequirementKind('{"kind":"other"}')).toBe("other");
    expect(parseTaskRequirementKind('{"kind":"uncertain"}')).toBe("uncertain");
    expect(parseTaskRequirementKind('```json\n{"kind":"requirement"}\n```')).toBe("requirement");
    expect(parseTaskRequirementKind("思考过程\n{\"kind\": \"other\"}\n完成")).toBe("other");

    expect(parseTaskRequirementKind("")).toBe("uncertain");
    expect(parseTaskRequirementKind("not json")).toBe("uncertain");
    expect(parseTaskRequirementKind('{"kind":"feature"}')).toBe("uncertain");
    expect(parseTaskRequirementKind("{broken")).toBe("uncertain");
  });

  test("calls LLM backend with JSON schema and clipped context, and degrades safely on errors", async () => {
    const requests: LlmCompleteRequest[] = [];
    const classify = createLlmTaskClassifier(
      async () => ({
        async complete(request) {
          requests.push(request);
          return '{"kind":"requirement"}';
        },
      }),
      5_000,
    );

    const longContext = "甲".repeat(2_000);
    const kind = await classify({
      title: "新增按周导出报表",
      description: "支持导出 CSV",
      hasImages: true,
      projectContext: longContext,
    });
    expect(kind).toBe("requirement");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.jsonSchema).toEqual(TASK_CLASSIFY_JSON_SCHEMA);
    expect(requests[0]?.timeoutMs).toBe(5_000);
    expect(requests[0]?.user).toContain("新增按周导出报表");
    expect(requests[0]?.user).toContain("支持导出 CSV");
    expect(requests[0]?.user).toContain("此处无法读取图片内容");
    expect(requests[0]?.user).toContain(`${"甲".repeat(1_500)}…`);
    expect(requests[0]?.user).not.toContain("甲".repeat(1_501));

    const noBackend = createLlmTaskClassifier(async () => null);
    expect(await noBackend({ title: "x", description: "", hasImages: false })).toBe("uncertain");

    const throwing = createLlmTaskClassifier(async () => ({
      async complete() {
        throw new Error("timeout");
      },
    }));
    expect(await throwing({ title: "x", description: "", hasImages: false })).toBe("uncertain");

    const invalidOutput = createLlmTaskClassifier(async () => ({
      async complete() {
        return "无法判断";
      },
    }));
    expect(await invalidOutput({ title: "x", description: "", hasImages: false })).toBe("uncertain");
  });
});
