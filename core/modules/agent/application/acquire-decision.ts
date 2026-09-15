/**
 * 决策获取：从模型 + Execution Strategy 拿到一个已解析、已审计的 AgentDecision。
 *
 * fresh（processAgentTurn）与 tool_recovery（processPlannedToolTurn）两条
 * 路径的共享实现。此前这段「模型调用 → FC 出口闸门 → 协议解析 → 审计事件」
 * 在 turn-runner 里各写一份（约 150 行重复），2026-09-07 幻觉工具回归被迫
 * 双处修复——本模块就是防再漂移的收口。只获取决策，不做落库处置
 * （处置统一在 decision-disposition）。
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { TextModel } from "../../model/contracts/text-model.js";
import type {
  TextModelMessage,
  TextToolCall,
  TextToolDefinition,
} from "../../model/contracts/text-generation-request.js";
import type { AgentExecutionStrategy } from "../contracts/execution-strategy.js";
import { parseAgentDecision } from "./agent-decision.js";
import type { AgentDecision } from "./agent-decision.js";
import { agentActionToDecision } from "./agent-action-to-decision.js";
import {
  completeAgentDecision,
  type AgentDecisionResponse,
} from "./complete-agent-decision.js";
import { isToolName } from "./tool-catalog.js";
import { recordAgentTurnEvent } from "./agent-turn-events.js";

type Database = NodePgDatabase<typeof schema>;

export type AcquireDecisionInput = {
  db: Database;
  client: TextModel;
  model: string;
  turnId: string;
  conversationId: string;
  /** 完整决策消息（system + 历史 [+ 工具回喂]），调用方按路径组装。 */
  decisionMessages: TextModelMessage[];
  /** FC 原生工具面（目录内）；空数组 = 不下发工具。 */
  nativeTools: TextToolDefinition[];
  strategy: AgentExecutionStrategy | null | undefined;
  decisionTimeoutMs?: number | undefined;
};

export type AcquiredDecision = {
  decision: AgentDecision;
  /** 进入审计事件的最终模型响应（可能被出口闸门的重试响应替换）。 */
  responseForAudit: AgentDecisionResponse;
};

/**
 * 调用模型获取决策：FC 原生 tool_calls 请求工具时映射为 use_tool 决策
 * （复用既有检查点/预算/恢复机制，只换协议皮肤）；目录外工具名（幻觉）
 * 走出口闸门回喂重试一次，仍幻觉则抛 invalid_fc_tool_calls 走既有重试链路，
 * 绝不落检查点（2026-09-07 双 5min 假死回归的防线）。
 */
export async function acquireDecision(
  input: AcquireDecisionInput,
): Promise<AcquiredDecision> {
  const { db, client, model, turnId, conversationId, strategy } = input;
  const modelResponse = await completeAgentDecision(
    client,
    input.decisionMessages,
    model,
    {
      timeoutMs: input.decisionTimeoutMs,
      ...(input.nativeTools.length > 0 ? { tools: input.nativeTools } : {}),
    },
  );
  await recordModelCallEvent(db, {
    turnId,
    conversationId,
    model,
    response: modelResponse,
  });

  let decision: AgentDecision;
  let responseForAudit = modelResponse;
  if (modelResponse.toolCalls && modelResponse.toolCalls.length > 0) {
    if (modelResponse.toolCalls.every((call) => isToolName(call.name))) {
      // FC 路径：模型以原生 tool_calls 请求工具 → 映射为 use_tool 决策。
      decision = decisionFromNativeToolCalls(modelResponse.toolCalls);
      if (modelResponse.toolCalls.length > 1) {
        await recordAgentTurnEvent(db, {
          turnId,
          conversationId,
          eventType: "extra_tool_calls_dropped",
          payload: {
            dropped: modelResponse.toolCalls.slice(1).map((call) => call.name),
          },
        });
      }
    } else {
      // FC 出口闸门：目录外工具名 = 模型把收尾意图包成了 tool_calls
      //（幻觉 "none"/"reply"）→ 回喂无效工具回执 + 摘工具面重试一次，
      // 逼 JSON 决策收尾。重试仍幻觉 → 抛错走既有重试链路。
      responseForAudit = await gateNativeToolCalls(db, {
        turnId,
        conversationId,
        toolCalls: modelResponse.toolCalls,
        messages: input.decisionMessages,
        client,
        model,
        decisionTimeoutMs: input.decisionTimeoutMs,
      });
      if (responseForAudit.toolCalls?.some((call) => !isToolName(call.name))) {
        throw new Error(
          `invalid_fc_tool_calls: ${responseForAudit.toolCalls.map((call) => call.name).join(",")}`,
        );
      }
      decision = parseDecision(strategy, responseForAudit.text);
    }
  } else {
    decision = parseDecision(strategy, modelResponse.text);
  }

  if (responseForAudit.reasoning) {
    await recordAgentTurnEvent(db, {
      turnId,
      conversationId,
      eventType: "model_reasoning",
      payload: { reasoning: responseForAudit.reasoning },
    });
  }
  return { decision, responseForAudit };
}

/** 策略路径经 AgentAction 适配，内置路径直接解析 JSON 决策协议。 */
function parseDecision(
  strategy: AgentExecutionStrategy | null | undefined,
  text: string,
): AgentDecision {
  return strategy
    ? agentActionToDecision(strategy.parseModelResponse({ text }))
    : parseAgentDecision(text);
}

/** 记录一次决策模型调用的可观测事实（token/延迟/finish_reason）。 */
async function recordModelCallEvent(
  db: Database,
  input: {
    turnId: string;
    conversationId: string;
    model: string;
    response: {
      text?: string | undefined;
      finishReason?: string | undefined;
      latencyMs?: number | undefined;
      toolCalls?: { name: string }[] | undefined;
      usage?:
        | {
            inputTokens?: number | undefined;
            outputTokens?: number | undefined;
            totalTokens?: number | undefined;
          }
        | undefined;
    };
  },
): Promise<void> {
  await recordAgentTurnEvent(db, {
    turnId: input.turnId,
    conversationId: input.conversationId,
    eventType: "model_call",
    payload: {
      finishReason: input.response.finishReason ?? null,
      latencyMs: input.response.latencyMs ?? null,
      usage: input.response.usage ?? null,
      // 模型原始输出前 2000 字，排查"该回没回"时看原文
      modelOutput: input.response.text?.slice(0, 2000) ?? null,
      // FC：模型请求的工具名（请求工具时 text 侧通常为空）
      ...(input.response.toolCalls
        ? { toolCalls: input.response.toolCalls.map((call) => call.name) }
        : {}),
    },
  });
}

/**
 * FC 协议：把原生 tool_calls 映射为 use_tool 决策（复用既有检查点/
 * 预算/恢复机制——只换协议皮肤，不换事务骨架）。多余调用由调用方
 * 落 extra_tool_calls_dropped 事件。参数 JSON 解析失败时留空参数，
 * 交由既有 invalid_tool_arguments/invalid_tool_plan 失败路径处理。
 */
function decisionFromNativeToolCalls(calls: TextToolCall[]) {
  const first = calls[0];
  if (!first) throw new Error("empty native tool calls");
  let args: Record<string, string> = {};
  try {
    const parsed = JSON.parse(first.arguments || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (typeof value === "string") args[key] = value;
      }
    }
  } catch {
    args = {};
  }
  return agentActionToDecision({
    kind: "use_tool",
    tool: first.name,
    arguments: args,
  });
}

/**
 * FC 出口闸门（2026-09-07 可可猫/私聊 395 双 5min 假死回归）：
 * 模型在工具链末端把收尾意图包成 tool_calls 时，工具名是幻觉
 * （实测 "none"/"reply"）。目录外工具名不落检查点、不进 disposition——
 * 而是作为一次「无效工具回执」回喂 + 摘掉工具面重试一次，逼模型
 * 以 JSON 决策收尾。重试结果照常返回，由调用方既有路径处理。
 */
async function gateNativeToolCalls(
  db: Database,
  input: {
    turnId: string;
    conversationId: string;
    toolCalls: TextToolCall[];
    /** 重试用的完整消息历史（调用侧原样回传，闸门追加回执消息对）。 */
    messages: TextModelMessage[];
    client: TextModel;
    model: string;
    decisionTimeoutMs?: number | undefined;
  },
): Promise<AgentDecisionResponse> {
  const unknownCall = input.toolCalls.find((call) => !isToolName(call.name));
  if (!unknownCall) {
    throw new Error("gateNativeToolCalls called with catalog tool calls");
  }
  await recordAgentTurnEvent(db, {
    turnId: input.turnId,
    conversationId: input.conversationId,
    eventType: "invalid_tool_call_retry",
    payload: {
      toolName: unknownCall.name,
      dropped: input.toolCalls.map((call) => call.name),
    },
  });
  // FC 回喂消息对：assistant(无效 tool_calls) + tool(回执)。摘掉工具面
  // 后模型无法继续以 tool_calls 输出，唯一出口是 JSON 决策协议。
  const retryMessages: TextModelMessage[] = [
    ...input.messages,
    {
      role: "assistant",
      content: "",
      toolCalls: input.toolCalls,
    },
    {
      role: "tool",
      toolCallId: unknownCall.id,
      content: JSON.stringify({
        error: "unknown_tool",
        message:
          "工具不存在。收尾/回复必须以 JSON 决策输出（next_action 等字段），不是工具调用。",
      }),
    },
  ];
  return await completeAgentDecision(input.client, retryMessages, input.model, {
    timeoutMs: input.decisionTimeoutMs,
  });
}
