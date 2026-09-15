/**
 * Agent Turn 编排层（TurnRunner）：
 * - processAgentTurn：全新决策路径（策略评估 → 上下文 → LLM 决策 → 动作）
 * - processPlannedToolTurn：工具检查点恢复路径（执行工具 → 最终回复）
 *
 * 只做编排，不做纯决策（决策在 reply-policy / turn-utils）；
 * 决策后处理（gate/handoff/no_action/校验/落库）统一在 decision-disposition；
 * 「从模型+策略拿决策」统一在 acquire-decision（曾双路径各写一份，
 * 2026-09-07 幻觉工具回归被迫双处修复——现收敛为单一实现）。
 * 仅由 AgentTurnExecutor.execute() 在完成 CAS 领取后调用（ADR-0001）。
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import {
  DEFAULT_BEHAVIOR_SETTINGS,
  type BehaviorSettings,
} from "./behavior-settings.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { TextModel } from "../../model/contracts/text-model.js";
import type {
  KnowledgeEvidence,
  KnowledgeSearch,
} from "../../knowledge/contracts/knowledge-search.js";
import type { SkillRegistry } from "../contracts/agent-skill.js";
import type { ExecutionStrategyRegistry } from "../contracts/execution-strategy.js";
import {
  buildSystemPrompt,
  evaluateReplyPolicy,
  resolveExecutionStrategy,
  collectSkillHints,
  collectSkillHintsAfterKnowledge,
} from "./reply-policy.js";
import {
  textOfContent,
  type TextModelContent,
  type TextModelMessage,
} from "../../model/contracts/text-generation-request.js";
import { decisionFieldContractText } from "./decision-contract.js";
import { executeToolPlan } from "./execute-tool-plan.js";
import { toNativeToolDefinitions } from "./tool-catalog.js";
import { AgentTurnTransitionNotApplied } from "./agent-turn-service.js";
import {
  commitAgentTurnFailure,
  commitAgentTurnSuppression,
} from "./agent-turn-outcome-command.js";
import { recordAgentTurnEvent } from "./agent-turn-events.js";
import { buildAgentContext } from "./agent-context.js";
import { commitDecisionDisposition } from "./decision-disposition.js";
import {
  classifyError,
  getAgentTurnConversationId,
} from "./turn-utils.js";
import { chatTypeFromConversationRef } from "../../conversations/application/chat-type.js";
import {
  acquireDecision,
} from "./acquire-decision.js";
import type { FileStorage } from "../../../infrastructure/file_storage/types.js";
import type { imageToContentPart } from "./image-content.js";
import type { AgentTurnExecutionInput } from "./agent-turn-executor.js";

type Database = NodePgDatabase<typeof schema>;

export type TurnRunnerDependencies = {
  knowledgeSearch?: KnowledgeSearch | undefined;
  skillRegistry?: SkillRegistry | undefined;
  strategyRegistry?: ExecutionStrategyRegistry | undefined;
  /**
   * Optional hook called before the strategy's buildModelRequest to
   * pre-resolve AI employee prompts from the database (populates the
   * strategy cache). `triggerText` (the latest inbound text) is passed
   * through but no longer drives any keyword routing — contact binding +
   * workspace default are the only routing rules (R2). Core stays
   * business-neutral.
   */
  preResolveAiEmployeePrompt?: (
    contactId: string,
    conversationId: string,
    triggerText?: string | undefined,
  ) => Promise<void>;
  /**
   * Optional hook resolving the AI employee identity (opaque string, e.g. a
   * definition id) for the conversation. When it returns a value, that value
   * is persisted as messages.actor_id on the agent reply so every surface
   * (Console / Mobile) can render the employee's own avatar. Core never
   * interprets the identifier.
   */
  resolveAiEmployeeId?: (
    contactId: string,
    conversationId: string,
  ) => Promise<string | null | undefined>;
  /**
   * 行为参数读取器（R2 设置中心）：会话 TTL/轮数/wait 缺省/ReAct 预算。
   * 未注入时使用出厂默认（与可配置前行为逐字节一致）。
   */
  behaviorSettings?: (() => Promise<BehaviorSettings>) | undefined;
  /**
   * 真 ReAct 循环开关：false 时 reply/ask 一律落 outcome 终态，不续步。
   * triage 直答档置 false（直答回复不升级回主力档）；缺省 true。
   */
  allowReplyContinuation?: boolean | undefined;
  /**
   * Agent 决策调用专用超时（THINKING-PIPELINE-PLAN B3，默认 180s）。
   * 长思考需要比其他模型调用更长的窗口；未注入时回落客户端配置。
   */
  decisionTimeoutMs?: number | undefined;
  /**
   * Phase 4 视觉直读：文件存储句柄（本地盘媒体根目录）。注入后才允许
   * 把「最新入站图片」作为 image_url 喂给主模型；不注入零行为变化
   * （图片维持文本占位/描述）。
   */
  imageStorage?: FileStorage;
  /** 可覆写的图片→image_url 构造器（测试注入用）；缺省用内建实现。 */
  readImage?: typeof imageToContentPart;
};

/**
 * 处理一个 Agent 轮次的全新决策路径：
 * 策略评估 → 上下文构建 → LLM 决策 → 统一决策后处理（decision-disposition）
 */
export async function processAgentTurn(
  db: Database,
  client: TextModel,
  model: string,
  job: AgentTurnExecutionInput,
  dependencies: TurnRunnerDependencies,
): Promise<{ continueLoop: boolean }> {
  const turns = await db
    .select()
    .from(schema.agentTurns)
    .where(eq(schema.agentTurns.turnId, job.turnId))
    .limit(1);
  const turn = turns[0];
  if (!turn) throw new Error(`agent turn ${job.turnId} does not exist`);
  // 已完成或已被取代的轮次直接跳过
  if (turn.status === "completed" || turn.status === "superseded") {
    return { continueLoop: false };
  }

  // 轮次已由 AgentTurnExecutor 通过 AgentTurnService 完成 CAS 领取
  await recordAgentTurnEvent(db, {
    turnId: turn.turnId,
    conversationId: turn.conversationId,
    eventType: "ownership_checked",
    payload: { allowed: true },
  });

  // 评估回复策略：检查 Agent 是否被禁用或 Handoff 是否激活
  const policy = await evaluateReplyPolicy(db, turn.conversationId);
  if (policy.action === "ignore") {
    await commitAgentTurnSuppression(db, {
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      reason: policy.reason,
    });
    return { continueLoop: false };
  }

  const [conversation] = await db
    .select({
      revision: schema.conversations.revision,
      contactId: schema.conversations.contactId,
      chatType: schema.conversations.chatType,
    })
    .from(schema.conversations)
    .where(eq(schema.conversations.conversationId, turn.conversationId))
    .limit(1);

  // 定时发送联系人开关（SCHEDULED-SEND-PLAN 决策 #3）：默认关。
  const [contactProfileRow] = conversation?.contactId
    ? await db
        .select({
          scheduledSendEnabled: schema.contactProfiles.scheduledSendEnabled,
        })
        .from(schema.contactProfiles)
        .where(eq(schema.contactProfiles.contactId, conversation.contactId))
        .limit(1)
    : [];

  // 会话类型（ADR-0010）：读 conversations.chat_type 事实（ingest 定一次）；
  // 行缺失的极端场景按通道约定兜底推导（全 Core 仅 ingest 与此兜底认识后缀）。
  const chatType =
    conversation?.chatType ?? chatTypeFromConversationRef(turn.conversationId);

  // 行为参数（R2）：读取失败/未注入时回落出厂默认，绝不阻断 Turn。
  // 提前到上下文构建前：轮窗摘要角色标签（roundSummaryLabels）随行为参数装配。
  let behavior: BehaviorSettings | undefined;
  try {
    behavior = dependencies.behaviorSettings
      ? await dependencies.behaviorSettings()
      : undefined;
  } catch {
    behavior = undefined;
  }

  // 构建 Agent 上下文（消息历史、记忆、上一人工周期摘要等）；
  // turn:wake:* 前缀 = 等待超时唤醒轮，上下文带"对方未回复"标记。
  const context = await buildAgentContext(db, turn.conversationId, chatType, {
    trigger: turn.turnId.startsWith("turn:wake:") ? "wake" : "message",
    ...(behavior?.roundSummaryLabels
      ? { roundLabels: behavior.roundSummaryLabels }
      : {}),
    ...(dependencies.imageStorage
      ? {
          image: dependencies.readImage
            ? {
                storage: dependencies.imageStorage,
                readImage: dependencies.readImage,
              }
            : { storage: dependencies.imageStorage },
        }
      : {}),
  });
  await recordAgentTurnEvent(db, {
    turnId: turn.turnId,
    conversationId: turn.conversationId,
    eventType: "context_built",
    payload: { historyCount: context.history.length },
  });

  try {
    // 解析执行策略：优先按执行 Profile 声明的 strategyRef，其次取注册表
    // 中已安装的第一个策略；都没有时使用内置通用 Prompt。
    const strategy = await resolveExecutionStrategy(
      db,
      turn,
      dependencies.strategyRegistry,
    );

    // AI 员工 Prompt 预解析：在策略的 buildModelRequest 之前异步查询数据库，
    // 将已发布的 AI 员工 prompt 填充到策略缓存中。触发文本取最近一条
    // 入站消息内容（R2 起仅作为上下文透传，关键词路由已删除）。
    if (dependencies.preResolveAiEmployeePrompt) {
      await dependencies.preResolveAiEmployeePrompt(
        conversation?.contactId ?? "",
        turn.conversationId,
        lastInboundText(context.history),
      );
    }
    // AI 员工身份：命中时写入 messages.actor_id，前端据此渲染员工头像
    const aiEmployeeId = dependencies.resolveAiEmployeeId
      ? ((await dependencies.resolveAiEmployeeId(
          conversation?.contactId ?? "",
          turn.conversationId,
        )) ?? null)
      : null;

    // FC 协议：原生工具面从 availableTools 派生（单一事实源，目录外忽略）。
    // 群聊/私聊对 availableTools 的增删自动反映到原生工具面。
    const availableTools = [
      ...(dependencies.knowledgeSearch ? ["retrieve_knowledge"] : []),
      "query_contact_profile",
      "fetch_url",
      // 群历史筛选仅群聊下发（私聊 20 条窗口 + 记忆已覆盖）
      ...(chatType === "group" ? ["search_chat_history"] : []),
    ];
    const nativeTools = toNativeToolDefinitions(availableTools);
    const strategySystem = strategy
      ? strategy.buildModelRequest({
          conversationId: turn.conversationId,
          contactId: conversation?.contactId ?? "",
          messages: historyAsText(context.history),
          facts: {},
          availableTools,
          chatType,
        }).system
      : buildSystemPrompt(Boolean(dependencies.knowledgeSearch), chatType, {
          scheduleSendEnabled: contactProfileRow?.scheduledSendEnabled === true,
        });

    // Skill 提示：SkillRegistry 中每个注册 Skill 的 beforeKnowledge 输出
    // 作为不透明上下文注入，平台不解释其内容。
    const skillHintSection = skillHintBlock(
      collectSkillHints(
        dependencies.skillRegistry,
        historyAsText(context.history),
      ),
    );

    // 调用 LLM 获取决策结果（FC：下发原生工具面；模型可能以 tool_calls 请求工具）
    const decisionMessages: TextModelMessage[] = [
      {
        role: "system",
        content: `${strategySystem}${context.prompt}${skillHintSection}`,
      },
      ...context.history,
    ];
    const { decision } = await acquireDecision({
      db,
      client,
      model,
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      decisionMessages,
      nativeTools,
      strategy,
      decisionTimeoutMs: dependencies.decisionTimeoutMs,
    });
    await recordAgentTurnEvent(db, {
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      eventType: "policy_decided",
      payload: {
        action: decision.nextAction,
        riskLevel: decision.riskLevel,
      },
    });

    // 行为参数已在上下文构建前加载（behavior）——此处直接复用。

    // 决策后处理：gate → superseded → 工具计划 → no_action → 校验 → 落库
    const disposition = await commitDecisionDisposition({
      decision,
      db,
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      traceId: job.traceId,
      path: "fresh",
      triggerMessageId: turn.triggerMessageId,
      conversationRevision: conversation?.revision ?? 0,
      model,
      aiEmployeeId,
      ...(behavior
        ? {
            defaultWaitMs: behavior.defaultWaitMs,
            defaultSessionTtlMinutes: behavior.sessionTtlMinutes,
            defaultSessionRoundBudget: behavior.sessionRoundBudget,
            decisionStepBudget: behavior.decisionStepBudget,
            replyStepBudget: behavior.replyStepBudget,
            ...(behavior.nudgeText
              ? { defaultNudgeText: behavior.nudgeText }
              : {}),
          }
        : {}),
      allowReplyContinuation: dependencies.allowReplyContinuation !== false,
      chatType,
      scheduledSend: {
        enabled: contactProfileRow?.scheduledSendEnabled === true,
        maxPending: behavior?.scheduledSendMaxPending ?? 2,
        maxPerDay: behavior?.scheduledSendMaxPerDay ?? 10,
        quietStartHour: behavior?.scheduledSendQuietStartHour ?? 22,
        quietEndHour: behavior?.scheduledSendQuietEndHour ?? 8,
      },
    });
    return { continueLoop: disposition.action === "continue" };
  } catch (error) {
    await recordTurnErrorAndRequeue(db, {
      turnId: turn.turnId,
      conversationId: turn.conversationId,
    }, error);
    throw error;
  }
}

/**
 * 处理已规划工具的轮次（工具检查点的恢复路径）：
 * 执行工具 → 基于工具结果重新决策 → 统一决策后处理（decision-disposition）
 */
export async function processPlannedToolTurn(
  db: Database,
  client: TextModel,
  model: string,
  job: AgentTurnExecutionInput,
  dependencies: TurnRunnerDependencies,
): Promise<{ continueLoop: boolean }> {
  // 查询待执行的工具计划（planned 或已成功但后续模型调用失败需要重试的）；
  // 多步 ReAct 同 turn 有多条计划，取最新一条（步数键按 createdAt 递增）
  const executions = await db
    .select()
    .from(schema.toolExecutions)
    .where(eq(schema.toolExecutions.turnId, job.turnId))
    .orderBy(
      desc(schema.toolExecutions.createdAt),
      desc(schema.toolExecutions.executionId),
    )
    .limit(1);
  const execution = executions[0];
  if (!execution) {
    const conversationId = await getAgentTurnConversationId(db, job.turnId);
    await commitAgentTurnFailure(db, {
      conversationId,
      turnId: job.turnId,
      errorCode: "tool_checkpoint_missing",
      handoffReason:
        "tool_checkpoint_missing: persisted tool plan is unavailable",
      events: [
        {
          eventType: "validation_failed",
          reasonCode: "tool_checkpoint_missing",
        },
      ],
    });
    return { continueLoop: false };
  }
  // 工具失败不再直接转人工：以「失败回执」进入恢复提示词，由模型决定
  // 无证据作答、换查询方式重试（计入步数预算），或确需人工时自行输出
  // handoff。持续性故障被步数预算封顶，不会无限循环。
  try {
    return await runPlannedToolTurnBody(db, client, model, job, dependencies, {
      execution,
    });
  } catch (error) {
    // 兜底契约与 fresh 路径一致：错误落事件（排错不依赖 stdout）、
    // running 重置为 queued 让队列重试/回收接管。事发时若缺这一层，
    // 异常静默退出会让 turn 假死到 STALE 兜底（2026-09-07 双 5min 回归）。
    await recordTurnErrorAndRequeue(db, {
      turnId: job.turnId,
      conversationId: execution.conversationId,
    }, error);
    throw error;
  }
}

/** processPlannedToolTurn 的主体检索/执行段（兜底 catch 拆分出去保持可读）。 */
async function runPlannedToolTurnBody(
  db: Database,
  client: TextModel,
  model: string,
  job: AgentTurnExecutionInput,
  dependencies: TurnRunnerDependencies,
  ctx: {
    execution: typeof schema.toolExecutions.$inferSelect;
  },
): Promise<{ continueLoop: boolean }> {
  const execution = ctx.execution;
  let toolFailure: { toolName: string; errorCode: string } | null = null;
  let toolResultPayload: Record<string, unknown> | undefined;
  let evidenceList: KnowledgeEvidence[] = [];
  if (execution.status === "failed") {
    // 上次执行已持久化为失败（如恢复模型调用前 worker 崩溃重投）：
    // 不再重复执行，直接以持久化的失败原因进入恢复路径。
    toolFailure = {
      toolName: execution.toolName,
      errorCode: execution.errorCode ?? "tool_execution_failed",
    };
  } else {
    // 执行工具计划（幂等：重复执行同一工具不会产生副作用）
    const toolResult = await executeToolPlan(db, execution.executionId, {
      knowledgeSearch: dependencies.knowledgeSearch,
    });
    await recordAgentTurnEvent(db, {
      turnId: job.turnId,
      conversationId: execution.conversationId,
      eventType: "tool_completed",
      reasonCode:
        toolResult.status === "succeeded" ||
        toolResult.status === "already_completed"
          ? undefined
          : (toolResult.errorCode ?? "tool_failed"),
      payload: { toolName: execution.toolName, status: toolResult.status },
    });
    // Another worker owns the current lease (or reclaimed it after this worker
    // became stale). The late worker must not create a duplicate Handoff or
    // overwrite the AgentTurn owned by the newer execution.
    if (toolResult.status === "not_claimable") {
      return { continueLoop: false };
    }
    if (
      toolResult.status !== "succeeded" &&
      toolResult.status !== "already_completed"
    ) {
      toolFailure = {
        toolName: execution.toolName,
        errorCode: toolResult.errorCode ?? "tool_failed",
      };
    } else {
      toolResultPayload = toolResult.result ?? {};
      if (
        execution.toolName === "retrieve_knowledge" &&
        Array.isArray(toolResult.result?.evidence)
      ) {
        evidenceList = toolResult.result.evidence as KnowledgeEvidence[];
      }
    }
  }
  const toolFacts = toolFailure
    ? toolFailureFacts(toolFailure.toolName, toolFailure.errorCode)
    : `\n工具执行结果（可信事实）：${JSON.stringify(toolResultPayload ?? {})}`;

  // 会话类型（ADR-0010）：读 conversations.chat_type 事实（ingest 定一次）。
  const [conversationTypeRow] = await db
    .select({ chatType: schema.conversations.chatType })
    .from(schema.conversations)
    .where(eq(schema.conversations.conversationId, execution.conversationId))
    .limit(1);
  const chatType =
    conversationTypeRow?.chatType ??
    chatTypeFromConversationRef(execution.conversationId);

  // 行为参数（R2）：提前加载供轮窗标签与后续预算使用。
  let behavior: BehaviorSettings | undefined;
  try {
    behavior = dependencies.behaviorSettings
      ? await dependencies.behaviorSettings()
      : undefined;
  } catch {
    behavior = undefined;
  }

  // 基于工具结果重新构建上下文，再次调用 LLM 生成最终回复
  const context = await buildAgentContext(
    db,
    execution.conversationId,
    chatType,
    {
      ...(behavior?.roundSummaryLabels
        ? { roundLabels: behavior.roundSummaryLabels }
        : {}),
      ...(dependencies.imageStorage
        ? {
            image: dependencies.readImage
              ? {
                  storage: dependencies.imageStorage,
                  readImage: dependencies.readImage,
                }
              : { storage: dependencies.imageStorage },
          }
        : {}),
    },
  );
  // Skill 提示：注册 Skill 的 afterKnowledge 输出作为不透明上下文注入
  const skillHintSection = skillHintBlock(
    collectSkillHintsAfterKnowledge(
      dependencies.skillRegistry,
      evidenceList,
      historyAsText(context.history),
    ),
  );

  const turns = await db
    .select({
      executionProfileId: schema.agentTurns.executionProfileId,
      // 吸收式回合：恢复路径同样以触发消息为基准检测客户插话
      triggerMessageId: schema.agentTurns.triggerMessageId,
    })
    .from(schema.agentTurns)
    .where(eq(schema.agentTurns.turnId, job.turnId))
    .limit(1);
  const [conversation] = await db
    .select({ contactId: schema.conversations.contactId })
    .from(schema.conversations)
    .where(eq(schema.conversations.conversationId, execution.conversationId))
    .limit(1);
  const strategy = await resolveExecutionStrategy(
    db,
    { executionProfileId: turns[0]?.executionProfileId ?? null },
    dependencies.strategyRegistry,
  );

  // AI 员工 Prompt 预解析（工具恢复路径）；触发文本取最近一条入站消息。
  if (dependencies.preResolveAiEmployeePrompt) {
    await dependencies.preResolveAiEmployeePrompt(
      conversation?.contactId ?? "",
      execution.conversationId,
      lastInboundText(context.history),
    );
  }
  // AI 员工身份（工具路径）：与主路径同语义，命中写入 actor_id
  const aiEmployeeId = dependencies.resolveAiEmployeeId
    ? ((await dependencies.resolveAiEmployeeId(
        conversation?.contactId ?? "",
        execution.conversationId,
      )) ?? null)
    : null;

  // 工具步数预算（有界 ReAct）：按本 turn 的工具执行记录数计算，失败的
  // 尝试同样计步——否则对持续性故障（如知识服务不可用）会无上限重试。
  // 步数达到上限时提示词禁止再次调工具（与 disposition 预算判定一致）；
  // 未达上限时允许模型继续规划 retrieve_knowledge / call_tool。
  const attemptedToolSteps = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.toolExecutions)
    .where(
      and(
        eq(schema.toolExecutions.turnId, job.turnId),
        inArray(schema.toolExecutions.status, [
          "succeeded",
          "planned",
          "failed",
        ]),
      ),
    );
  const toolStepsUsed = attemptedToolSteps[0]?.count ?? 1;
  // 行为参数已在上下文构建前加载（behavior）——此处直接复用。
  const toolStepBudget = (behavior ?? DEFAULT_BEHAVIOR_SETTINGS).toolStepBudget;
  const budgetExhausted = toolStepsUsed >= toolStepBudget;

  // 恢复路径的 availableTools 与预算对齐：预算未耗尽且检索能力在位时
  // 如实上报（策略插件据此生成「知识库可用」提示），耗尽则禁用工具。
  const recoveryAvailableTools = budgetExhausted
    ? []
    : [
        ...(dependencies.knowledgeSearch ? ["retrieve_knowledge"] : []),
        "query_contact_profile",
        "fetch_url",
        ...(chatType === "group" ? ["search_chat_history"] : []),
      ];

  const strategySystem = strategy
    ? strategy.buildModelRequest({
        conversationId: execution.conversationId,
        contactId: conversation?.contactId ?? "",
        messages: historyAsText(context.history),
        facts: {},
        availableTools: recoveryAvailableTools,
        chatType,
      }).system
    : buildSystemPrompt(
        !budgetExhausted && Boolean(dependencies.knowledgeSearch),
        chatType,
      );

  const decisionInstruction = toolFailure
    ? "请基于以上情况生成最终决策：可基于既有对话信息直接作答，或坦诚告知对方暂时无法完成该项查询；不得虚构工具结果。只输出 JSON。"
    : "请基于工具结果输出最终决策：只输出 JSON，不要 Markdown，不要自然语言叙述；不得依据常识补全工具结果或声称执行了尚未执行的动作。\n- " +
      decisionFieldContractText();

  // FC 协议：把工具调用与结果以 assistant(tool_calls) + tool 消息对回喂
  //（替代旧文本注入），ID 用执行记录合成、请求内自洽即可。
  const toolCallId = `call_${execution.executionId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const fcToolMessages: TextModelMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: toolCallId,
          name: execution.toolName,
          arguments: JSON.stringify(execution.arguments ?? {}),
        },
      ],
    },
    {
      role: "tool",
      toolCallId,
      content: JSON.stringify(
        toolFailure
          ? { error: toolFailure.errorCode }
          : (toolResultPayload ?? {}),
      ),
    },
  ];
  const recoveryNativeTools = budgetExhausted
    ? []
    : toNativeToolDefinitions(recoveryAvailableTools);

  const decisionMessages: TextModelMessage[] = [
    {
      role: "system",
      content: `${strategySystem}${context.prompt}${toolFacts}${skillHintSection}\n${decisionInstruction}next_action 必须为 reply、ask_for_information、handoff、no_action、wait、end_session 或 schedule_send${budgetExhausted ? "，不得再次调用工具（工具步数预算已耗尽）" : "；确有必要时可再次调用 retrieve_knowledge 或 call_tool 继续查证"}。`,
    },
    ...context.history,
    ...fcToolMessages,
  ];
  // 决策获取与 fresh 路径共用单一实现（FC 出口闸门/协议解析/审计事件）
  const { decision } = await acquireDecision({
    db,
    client,
    model,
    turnId: job.turnId,
    conversationId: execution.conversationId,
    decisionMessages,
    nativeTools: recoveryNativeTools,
    strategy,
    decisionTimeoutMs: dependencies.decisionTimeoutMs,
  });

  // 决策后处理：gate → 工具步数预算 → 吸收检查 → no_action → 校验 → 落库
  const disposition = await commitDecisionDisposition({
    decision,
    db,
    turnId: job.turnId,
    conversationId: execution.conversationId,
    traceId: job.traceId,
    path: "tool_recovery",
    conversationRevision: null,
    model,
    aiEmployeeId,
    chatType,
    triggerMessageId: turns[0]?.triggerMessageId ?? undefined,
    toolStepsUsed,
    toolStepBudget,
    ...(behavior
      ? {
          defaultWaitMs: behavior.defaultWaitMs,
          defaultSessionTtlMinutes: behavior.sessionTtlMinutes,
          defaultSessionRoundBudget: behavior.sessionRoundBudget,
          decisionStepBudget: behavior.decisionStepBudget,
          replyStepBudget: behavior.replyStepBudget,
          ...(behavior.nudgeText
            ? { defaultNudgeText: behavior.nudgeText }
            : {}),
        }
      : {}),
  });
  return { continueLoop: disposition.action === "continue" };
}

/**
 * 双路径共有的错误尾：AgentTurnTransitionNotApplied 原样上抛（不落事件、
 * 不重置状态——它属于执行权交接，不是可重试故障）；其余错误落 turn_error
 * 事件（排错不依赖 stdout）并把 running 重置为 queued，让队列重试/回收接管。
 */
async function recordTurnErrorAndRequeue(
  db: Database,
  ids: { turnId: string; conversationId: string },
  error: unknown,
): Promise<void> {
  if (error instanceof AgentTurnTransitionNotApplied) throw error;
  const errorCode = classifyError(error);
  // 错误统一落事件；落库失败不阻断重试链路
  await recordAgentTurnEvent(db, {
    turnId: ids.turnId,
    conversationId: ids.conversationId,
    eventType: "turn_error",
    reasonCode: errorCode,
    payload: {
      message:
        error instanceof Error ? error.message.slice(0, 500) : String(error),
    },
  }).catch(() => undefined);
  await db
    .update(schema.agentTurns)
    .set({
      status: "queued",
      errorCode,
    })
    .where(
      and(
        eq(schema.agentTurns.turnId, ids.turnId),
        eq(schema.agentTurns.status, "running"),
      ),
    );
}

/**
 * 工具失败回执：工具失败不转人工，而是把失败原因如实注入恢复提示词，
 * 由模型决定降级作答或自行请求人工。回执明确禁止虚构结果。
 */
function toolFailureFacts(toolName: string, errorCode: string): string {
  return `\n工具执行结果（可信事实）：工具「${toolName}」本次执行失败（原因：${errorCode}），没有返回任何可用结果。不得虚构查询结果，也不得声称已完成该查询或操作。`;
}

/**
 * 将 Skill 提示列表包装为 system prompt 注入块；空列表返回空串。
 */
function skillHintBlock(skillHints: string[]): string {
  return skillHints.length > 0
    ? `\n\n技能提示（由已安装的 Solution Skill 提供，可参考但不得向对方复述）：\n${skillHints.join("\n")}`
    : "";
}

/**
 * 取消息历史中最近一条入站（user 角色）文本，作为接待编排路由的触发文本。
 * 历史按时间升序，从尾部向前找；找不到（空会话/纯出站）返回 undefined，
 * 调用方按「无路由输入」处理。该辅助不理解任何业务关键词。
 */
export function lastInboundText(
  history: readonly { role: "user" | "assistant"; content: TextModelContent }[],
): string | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (!message || message.role !== "user") continue;
    const text = textOfContent(message.content);
    if (text.trim() !== "") return text;
  }
  return undefined;
}

/** 把多模态历史（可能含 image part）压平回纯文本，供契约仍为 string 的消费方。 */
function historyAsText(
  history: readonly { role: "user" | "assistant"; content: TextModelContent }[],
): { role: "user" | "assistant"; content: string }[] {
  return history.map((message) => ({
    role: message.role,
    content: textOfContent(message.content),
  }));
}
