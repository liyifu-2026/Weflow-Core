/**
 * FC（原生 function calling）协议层测试：
 * - 客户端 tool_calls 解析 / tools 下发 / tool 消息透传 / 空重试豁免
 * - completeAgentDecision 的工具透传与降上下文重试时的消息对完整性
 * - 工具目录 → 原生工具定义派生
 */
import { describe, expect, it } from "vitest";
import { OpenAiCompatibleClient } from "../infrastructure/model_runtime/openai-compatible-client.js";
import { completeAgentDecision } from "../modules/agent/application/complete-agent-decision.js";
import { toNativeToolDefinitions } from "../modules/agent/application/tool-catalog.js";

function clientWithResponses(
  responses: unknown[],
  bodies: unknown[] = [],
): OpenAiCompatibleClient {
  let call = 0;
  return new OpenAiCompatibleClient({
    baseUrl: "https://api.deepseek.com",
    apiKey: "test-only",
    model: "deepseek-v4-flash",
    timeoutMs: 1_000,
    fetch: (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      bodies.push(body);
      const payload = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });
}

const toolCallsPayload = {
  choices: [
    {
      message: {
        content: null,
        reasoning_content: "需要先检索知识库",
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: {
              name: "retrieve_knowledge",
              arguments: '{"query":"错误码2272"}',
            },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
};

describe("OpenAI-compatible client FC protocol", () => {
  it("parses tool_calls without treating them as an empty response", async () => {
    const bodies: unknown[] = [];
    const client = clientWithResponses([toolCallsPayload], bodies);
    const result = await client.generate({
      messages: [{ role: "user", content: "v9打不开" }],
      output: "structured",
    });

    expect(result.text).toBe("");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      {
        id: "call_abc",
        name: "retrieve_knowledge",
        arguments: '{"query":"错误码2272"}',
      },
    ]);
    expect(result.reasoning).toBe("需要先检索知识库");
    // tool_calls 不是空响应：不得触发 250ms 空重试
    expect(bodies.length).toBe(1);
  });

  it("passes tools + tool_choice in the request body and forwards tool messages", async () => {
    const bodies: unknown[] = [];
    const client = clientWithResponses([toolCallsPayload], bodies);
    const tools = toNativeToolDefinitions(["retrieve_knowledge"]);

    await client.generate({
      messages: [
        { role: "system", content: "你是客服。输出 json。" },
        { role: "user", content: "报错误码2272" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_abc", name: "retrieve_knowledge", arguments: "{}" },
          ],
        },
        { role: "tool", toolCallId: "call_abc", content: '{"evidence":[]}' },
      ],
      output: "structured",
      tools,
    });

    const body = bodies[0] as {
      tools: unknown[];
      tool_choice: string;
      messages: Array<{
        role: string;
        tool_call_id?: string;
        tool_calls?: unknown[];
      }>;
    };
    expect(body.tool_choice).toBe("auto");
    expect(body.tools).toHaveLength(1);
    expect(
      (body.tools[0] as { function: { name: string } }).function.name,
    ).toBe("retrieve_knowledge");
    const toolMessage = body.messages.find((m) => m.role === "tool");
    expect(toolMessage?.tool_call_id).toBe("call_abc");
    expect(
      body.messages.find((m) => m.role === "assistant")?.tool_calls,
    ).toBeTruthy();
  });

  it("surfaces content and tool_calls when they coexist", async () => {
    const client = clientWithResponses([
      {
        choices: [
          {
            message: {
              content: "我来帮您查询。",
              tool_calls: [
                {
                  id: "call_1",
                  function: { name: "fetch_url", arguments: '{"url":"x"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);
    const result = await client.generate({
      messages: [{ role: "user", content: "帮我看下这个链接" }],
    });
    expect(result.text).toBe("我来帮您查询。");
    expect(result.toolCalls?.[0]?.name).toBe("fetch_url");
  });
});

describe("completeAgentDecision FC passthrough", () => {
  it("surfaces toolCalls from the wrapped client", async () => {
    const bodies: unknown[] = [];
    const client = clientWithResponses([toolCallsPayload], bodies);
    const tools = toNativeToolDefinitions(["retrieve_knowledge"]);
    const response = await completeAgentDecision(
      client,
      [{ role: "user", content: "报错误码2272" }],
      undefined,
      { tools },
    );

    expect(response.toolCalls?.[0]?.name).toBe("retrieve_knowledge");
    expect(response.text).toBe("");
  });

  it("keeps assistant/tool message pairs intact in the reduced-context retry", async () => {
    const bodies: unknown[] = [];
    // 第一次返回截断（客户端抛 model_output_truncated → 触发降上下文重试），
    // 第二次返回正常决策 JSON。
    const client = clientWithResponses(
      [
        {
          choices: [
            {
              message: { content: "" },
              finish_reason: "length",
            },
          ],
        },
        {
          choices: [
            {
              message: {
                content:
                  '{"next_action":"reply","reply_text":"收到，我看下。","requires_human":false,"risk_level":"low"}',
              },
              finish_reason: "stop",
            },
          ],
        },
      ],
      bodies,
    );
    const messages = [
      { role: "system" as const, content: "system prompt json" },
      { role: "user" as const, content: "旧消息1" },
      { role: "user" as const, content: "旧消息2" },
      { role: "user" as const, content: "旧消息3" },
      { role: "user" as const, content: "v9打不开" },
      {
        role: "assistant" as const,
        content: "",
        toolCalls: [
          {
            id: "call_pair",
            name: "retrieve_knowledge",
            arguments: '{"query":"2272"}',
          },
        ],
      },
      { role: "tool" as const, toolCallId: "call_pair", content: '{"e":1}' },
    ];

    const response = await completeAgentDecision(
      client,
      messages,
      undefined,
      {},
    );
    expect(response.text).toContain("收到");

    // 重试请求必须保留完整 assistant(toolCalls)+tool 消息对（防孤儿 tool 消息 400）
    const retryBody = bodies[1] as {
      messages: Array<{ role: string; tool_call_id?: string }>;
    };
    const toolMessage = retryBody.messages.find((m) => m.role === "tool");
    expect(toolMessage?.tool_call_id).toBe("call_pair");
    const assistantMessage = retryBody.messages.find(
      (m) => m.role === "assistant",
    );
    expect(assistantMessage).toBeTruthy();
  });
});

describe("tool catalog → native tool definitions", () => {
  it("derives definitions for available tools and drops unknown names", () => {
    const defs = toNativeToolDefinitions([
      "retrieve_knowledge",
      "query_contact_profile",
      "fetch_url",
      "search_chat_history",
      "not_a_real_tool",
    ]);
    expect(defs.map((def) => def.function.name)).toEqual([
      "retrieve_knowledge",
      "query_contact_profile",
      "fetch_url",
      "search_chat_history",
    ]);
    for (const def of defs) {
      expect(def.type).toBe("function");
      expect(def.function.description.length).toBeGreaterThan(0);
      expect(def.function.parameters).toBeTruthy();
    }
  });

  it("describes search_chat_history with speaker/group scopes", () => {
    const defs = toNativeToolDefinitions(["search_chat_history"]);
    expect(defs).toHaveLength(1);
    const def = defs[0];
    expect(def?.function.name).toBe("search_chat_history");
    const properties = (
      def?.function.parameters as {
        properties: Record<string, { enum?: string[] }>;
      }
    ).properties;
    expect(properties.scope?.enum).toEqual(["speaker", "group"]);
  });
});
