import { describe, expect, it, vi } from "vitest";
import { completeAgentDecision } from "../modules/agent/application/complete-agent-decision.js";
import { OpenAiCompatibleClient } from "../infrastructure/model_runtime/openai-compatible-client.js";
import { OpenAiTextModelProvider } from "../infrastructure/model/openai-text-model-provider.js";
import { TextModelError } from "../modules/model/contracts/text-model-error.js";

describe("TextModel capability", () => {
  it("returns provider-neutral metadata and honors runtime model selection", async () => {
    const fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { model: string };
        return Promise.resolve(
          Response.json({
            choices: [{ message: { content: "hello" } }],
            model: body.model,
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        );
      },
    );
    const client = new OpenAiCompatibleClient({
      baseUrl: "https://example.test",
      apiKey: "secret",
      model: "default-model",
      timeoutMs: 1_000,
      fetch,
    });
    const provider = new OpenAiTextModelProvider(client);

    await expect(
      provider.generate({
        messages: [{ role: "user", content: "hello" }],
        modelId: "runtime-model",
        output: "text",
      }),
    ).resolves.toMatchObject({
      text: "hello",
      modelId: "runtime-model",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });
  });

  it("lets the Agent application request structured output without provider types", async () => {
    const generate = vi.fn().mockResolvedValue({
      text: '{"next_action":"no_action"}',
      modelId: "agent-model",
    });
    const response = await completeAgentDecision(
      { generate },
      [{ role: "user", content: "hello" }],
      "agent-model",
    );

    expect(response).toBe('{"next_action":"no_action"}');
    expect(generate).toHaveBeenCalledWith({
      messages: [{ role: "user", content: "hello" }],
      modelId: "agent-model",
      output: "structured",
    });
  });

  it("preserves the existing shortened-context retry for empty structured output", async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce(
        new TextModelError("invalid_response", "empty", {
          reason: "empty_response",
        }),
      )
      .mockResolvedValueOnce({
        text: '{"next_action":"no_action"}',
        modelId: "m",
      });

    await expect(
      completeAgentDecision(
        { generate },
        [
          { role: "system", content: "rules" },
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
          { role: "user", content: "three" },
          { role: "assistant", content: "four" },
          { role: "user", content: "five" },
        ],
        "m",
      ),
    ).resolves.toBe('{"next_action":"no_action"}');
    expect(generate).toHaveBeenCalledTimes(2);
    const retryRequest = generate.mock.calls[1]?.[0] as
      { messages: unknown[] } | undefined;
    expect(retryRequest?.messages).toHaveLength(5);
  });
});
