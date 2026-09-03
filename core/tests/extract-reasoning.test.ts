import { describe, expect, it } from "vitest";

import {
  extractReasoning,
} from "../infrastructure/model_runtime/openai-compatible-client.js";

describe("extractReasoning（思维链提取）", () => {
  it("从 choices[0].message.reasoning_content 提取思维链", () => {
    const payload = {
      choices: [{ message: { content: "答案", reasoning_content: "思考过程" } }],
    };
    expect(extractReasoning(payload)).toBe("思考过程");
  });

  it("无 reasoning_content 或空串返回 undefined（不落空事件）", () => {
    expect(extractReasoning({ choices: [{ message: { content: "答案" } }] })).toBeUndefined();
    expect(
      extractReasoning({ choices: [{ message: { content: "a", reasoning_content: "" } }] }),
    ).toBeUndefined();
    expect(extractReasoning({})).toBeUndefined();
    expect(extractReasoning(null)).toBeUndefined();
  });

  it("思维链超长截断到 8000 字符", () => {
    const long = "x".repeat(10_000);
    const result = extractReasoning({ choices: [{ message: { content: "a", reasoning_content: long } }] });
    expect(result?.length).toBe(8_000);
  });
});
