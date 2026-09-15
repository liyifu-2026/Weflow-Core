/**
 * completeAgentDecision 单元测试（THINKING-PIPELINE-PLAN B2）：
 * - 截断（finish_reason=length → reason=truncated）：降上下文重试一次；
 *   再截断则抛出（由失败协调器转人工，reason=model_output_truncated）。
 * - 空响应保持既有降上下文重试行为。
 * - 成功调用回传 usage/latencyMs/finishReason 供观测。
 */
import { describe, expect, it, vi } from "vitest";
import type { TextModel } from "../modules/model/contracts/text-model.js";
import type {
  TextGenerationRequest,
  TextModelMessage,
} from "../modules/model/contracts/text-generation-request.js";
import type { TextGenerationResult } from "../modules/model/contracts/text-generation-result.js";
import { TextModelError } from "../modules/model/contracts/text-model-error.js";
import { completeAgentDecision } from "../modules/agent/application/complete-agent-decision.js";

function truncatedError(): TextModelError {
  return new TextModelError(
    "invalid_response",
    "model_output_truncated: finish_reason=length (budget exhausted, likely long thinking)",
    { reason: "truncated", retryable: true },
  );
}

function okResult(text: string): TextGenerationResult {
  return {
    text,
    modelId: "test",
    finishReason: "completed",
    latencyMs: 120,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  };
}

function fakeModel(
  responses: Array<
    TextGenerationResult | Promise<TextGenerationResult> | TextModelError
  >,
) {
  const queue = [...responses];
  const generate = vi.fn(async (request: TextGenerationRequest) => {
    if (request.messages.length === 0) {
      throw new Error("empty messages");
    }
    const next = queue.shift();
    if (next === undefined) throw new Error("no queued response");
    if (next instanceof TextModelError) throw next;
    return await next;
  });
  return {
    model: { generate } as unknown as TextModel,
    generate,
  };
}

const MESSAGES = [
  { role: "system" as const, content: "system prompt" },
  { role: "user" as const, content: "m1" },
  { role: "assistant" as const, content: "a1" },
  { role: "user" as const, content: "m2" },
];

describe("completeAgentDecision — 截断处置（决策 #2）", () => {
  it("首次截断：降上下文重试一次，成功则返回", async () => {
    const { model, generate } = fakeModel([
      truncatedError(),
      okResult('{"next_action":"reply"}'),
    ]);

    const result = await completeAgentDecision(model, MESSAGES);

    expect(result.text).toBe('{"next_action":"reply"}');
    expect(generate).toHaveBeenCalledTimes(2);
    // 重试时裁剪上下文：系统提示 + 最近 4 条（系统提示可能重复出现，既有行为）
    const retryRequest = generate.mock.calls[1]?.[0] as TextGenerationRequest;
    expect(retryRequest.messages).toHaveLength(5);
    expect(retryRequest.messages[0]?.content).toBe("system prompt");
    expect(retryRequest.messages.at(-1)?.content).toBe("m2");
  });

  it("连续截断：重试一次后仍截断则抛出（转人工由失败协调器负责）", async () => {
    const { model, generate } = fakeModel([
      truncatedError(),
      truncatedError(),
    ]);

    await expect(completeAgentDecision(model, MESSAGES)).rejects.toThrow(
      /model_output_truncated/,
    );
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("成功调用回传 finishReason/usage/latency 供观测", async () => {
    const { model } = fakeModel([okResult("{}")]);
    const result = await completeAgentDecision(model, MESSAGES);
    expect(result.finishReason).toBe("completed");
    expect(result.latencyMs).toBe(120);
    expect(result.usage?.totalTokens).toBe(150);
  });
});

describe("completeAgentDecision — 视觉直读（Phase 4）", () => {
  it("消息含 image_url 段时 thinking=true（视觉模型在思考关闭+json 下输出空白）", async () => {
    const { model, generate } = fakeModel([
      okResult('{"next_action":"reply"}'),
    ]);
    const visionMessages: TextModelMessage[] = [
      { role: "system" as const, content: "sys" },
      {
        role: "user" as const,
        content: [
          { type: "text", text: "看图" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ];

    await completeAgentDecision(model, visionMessages);

    const request = generate.mock.calls[0]?.[0] as TextGenerationRequest;
    expect(request.thinking).toBe(true);
  });

  it("无图的纯文本路径保持 thinking=false（零行为变化）", async () => {
    const { model, generate } = fakeModel([
      okResult('{"next_action":"reply"}'),
    ]);

    await completeAgentDecision(model, MESSAGES);

    const request = generate.mock.calls[0]?.[0] as TextGenerationRequest;
    expect(request.thinking).toBe(false);
  });
});
