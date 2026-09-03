import { describe, expect, it, vi } from "vitest";

import { OpenAiCompatibleClient } from "../infrastructure/model_runtime/openai-compatible-client.js";

describe("OpenAiCompatibleClient multimodal content（Phase 4）", () => {
  it("数组 content 原样进入请求体（text + image_url 段），string 行为不变", async () => {
    const bodies: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
      return Promise.resolve(
        Response.json({
          choices: [{ message: { content: "ok" } }],
        }),
      );
    });
    const client = new OpenAiCompatibleClient({
      baseUrl: "https://api.example/v1",
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 1_000,
      fetch,
    });

    // 既有 string 用法
    await client.complete([{ role: "user", content: "纯文本" }]);
    expect(bodies[0]).toMatchObject({
      messages: [{ role: "user", content: "纯文本" }],
    });

    // Phase 4 图文混合用法
    await client.complete([
      { role: "system", content: "你是客服" },
      {
        role: "user",
        content: [
          { type: "text", text: "这张截图里的订单号是多少？" },
          { type: "image_url", image_url: { url: "https://img.example/1.png" } },
        ],
      },
    ]);
    expect(bodies[1]).toMatchObject({
      messages: [
        { role: "system", content: "你是客服" },
        {
          role: "user",
          content: [
            { type: "text", text: "这张截图里的订单号是多少？" },
            {
              type: "image_url",
              image_url: { url: "https://img.example/1.png" },
            },
          ],
        },
      ],
    });
  });
});
