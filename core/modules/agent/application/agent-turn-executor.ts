/**
 * Durable Agent Turn execution seam.
 *
 * The worker owns queue/process lifecycle only. This module owns the decision
 * of whether a turn starts from a fresh model decision or resumes a persisted
 * tool checkpoint, and is the only Agent Turn entry point (ADR-0001).
 *
 * 分层（ADR-0001 重构后）：
 * - 本文件：turn 状态机编排（终态短路、CAS 领取、恢复路径分派）
 * - turn-runner.ts：全新决策路径与工具恢复路径的执行编排
 * - reply-policy.ts：回复策略评估、系统提示词、Execution Strategy 与 Skill 提示
 * - turn-utils.ts：状态/错误/会话类型纯工具
 */

import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { TextModel } from "../../model/contracts/text-model.js";
import type { KnowledgeSearch } from "../../knowledge/contracts/knowledge-search.js";
import type { SkillRegistry } from "../contracts/agent-skill.js";
import type { ExecutionStrategyRegistry } from "../contracts/execution-strategy.js";
import { AgentTurnService } from "./agent-turn-service.js";
import { recordAgentTurnEvent } from "./agent-turn-events.js";
import { processAgentTurn, processPlannedToolTurn } from "./turn-runner.js";
import type { FileStorage } from "../../../infrastructure/file_storage/types.js";
import type { imageToContentPart } from "./image-content.js";
import { commitAgentTurnHandoff } from "./agent-turn-outcome-command.js";
import type { TriageVerdict } from "./triage-classifier.js";
import type { BehaviorSettings } from "./behavior-settings.js";
import { isTerminal, normalizeStatus } from "./turn-utils.js";

type Database = NodePgDatabase<typeof schema>;

export type AgentTurnExecutionInput = {
  turnId: string;
  traceId: string;
};

export type AgentTurnExecutionStatus =
  | "completed"
  | "failed"
  | "superseded"
  | "suppressed_policy"
  | "suppressed_handoff"
  | "queued"
  | "tool_planned"
  | "running"
  | "unknown";

export type AgentTurnExecutionResult = {
  turnId: string;
  conversationId: string;
  status: AgentTurnExecutionStatus;
  resumed: boolean;
};

export class AgentTurnExecutor {
  public constructor(
    private readonly db: Database,
    private readonly modelClient: TextModel,
    private readonly model: string,
    private readonly dependencies: {
      knowledgeSearch?: KnowledgeSearch | undefined;
      skillRegistry?: SkillRegistry | undefined;
      strategyRegistry?: ExecutionStrategyRegistry | undefined;
      /**
       * Optional hook called before strategy.buildModelRequest to pre-resolve
       * AI employee prompts from the database (populates strategy cache).
       * `triggerText` is optional and drives reception-plan keyword routing
       * inside the Solution strategy; Core stays business-neutral.
       */
      preResolveAiEmployeePrompt?: (
        contactId: string,
        conversationId: string,
        triggerText?: string | undefined,
      ) => Promise<void>;
      /**
       * Optional hook resolving the AI employee identity for the conversation.
       * Returned opaque string is persisted as messages.actor_id on the agent
       * reply (used by surfaces to render the employee's avatar).
       */
      resolveAiEmployeeId?: (
        contactId: string,
        conversationId: string,
      ) => Promise<string | null | undefined>;
      /**
       * 预判分流（Triage）：可选；未提供时零行为变化。
       * - classify 由组合根注入策略（关键词/开关）与判定模型，永不抛错；
       * - fast 直答档位同样走 processAgentTurn 全套闸门。
       */
      triage?: {
        classify: (context: {
          triggerText: string;
          recentInboundTexts: string[];
        }) => Promise<TriageVerdict>;
        fastClient?: TextModel | undefined;
        fastModel?: string | undefined;
      };
      /**
       * 行为参数（R2 设置中心）：会话 TTL/轮数/wait 缺省/ReAct 预算的
       * 读取器（组合根注入，带 TTL 缓存）。未注入时逐项使用出厂默认，
       * 与可配置前的行为逐字节一致。
       */
      behaviorSettings?: (() => Promise<BehaviorSettings>) | undefined;
      /** Agent 决策调用专用超时（THINKING-PIPELINE-PLAN B3，默认 180s） */
      decisionTimeoutMs?: number | undefined;
      /** Phase 4 视觉直读：文件存储句柄（媒体根目录）。注入后允许把最新入站图片喂给主模型。 */
      imageStorage?: FileStorage;
      /** 可覆写的图片→image_url 构造器（测试注入用）。 */
      readImage?: typeof imageToContentPart;
    } = {},
  ) {}

  /** Execute a fresh or persisted Agent Turn. */
  public async execute(
    input: AgentTurnExecutionInput,
  ): Promise<AgentTurnExecutionResult> {
    const before = await this.loadTurn(input.turnId);
    if (!before) throw new Error(`agent turn ${input.turnId} does not exist`);

    if (isTerminal(before.status)) {
      return {
        turnId: before.turnId,
        conversationId: before.conversationId,
        status: normalizeStatus(before.status),
        resumed: false,
      };
    }

    const persistedExecution = await this.loadToolExecution(input.turnId);
    const resumed =
      before.status === "tool_planned" ||
      (before.status === "queued" && persistedExecution !== undefined);
    const turnService = new AgentTurnService(this.db);
    if (
      before.status === "queued" &&
      persistedExecution?.status === "running" &&
      (!persistedExecution.leaseUntil ||
        persistedExecution.leaseUntil.getTime() > Date.now())
    ) {
      return this.resultAfterExecution(before, resumed);
    }
    if (before.status === "tool_planned") {
      const claimed = await turnService.claim(input.turnId, this.model, [
        "tool_planned",
      ]);
      if (!claimed.applied) {
        const current = await this.loadTurn(input.turnId);
        return {
          turnId: input.turnId,
          conversationId: current?.conversationId ?? before.conversationId,
          status: normalizeStatus(current?.status ?? before.status),
          resumed,
        };
      }
      await recordAgentTurnEvent(this.db, {
        turnId: before.turnId,
        conversationId: before.conversationId,
        eventType: "execution_resumed",
        payload: { sourceStatus: "tool_planned" },
      });
      const first = await processPlannedToolTurn(
        this.db,
        this.modelClient,
        this.model,
        { turnId: input.turnId, traceId: input.traceId },
        this.dependencies,
      );
      await this.runStepLoop(input, turnService, first.continueLoop);
    } else if (before.status === "queued") {
      const claimed = await turnService.claim(input.turnId, this.model, [
        "queued",
      ]);
      if (!claimed.applied) {
        return this.resultAfterExecution(before, resumed);
      }
      await recordAgentTurnEvent(this.db, {
        turnId: before.turnId,
        conversationId: before.conversationId,
        eventType: "ownership_checked",
        payload: { allowed: true, sourceStatus: before.status },
      });

      if (resumed) {
        await recordAgentTurnEvent(this.db, {
          turnId: before.turnId,
          conversationId: before.conversationId,
          eventType: "execution_resumed",
          payload: { sourceStatus: before.status },
        });
        const first = await processPlannedToolTurn(
          this.db,
          this.modelClient,
          this.model,
          { turnId: input.turnId, traceId: input.traceId },
          this.dependencies,
        );
        await this.runStepLoop(input, turnService, first.continueLoop);
      } else {
        // 预判分流：规则 + 极速 LLM 分类，高危转人工 / simple 走直答档。
        // classify 内部 fail-open 永不抛错；未注入 triage 时零行为变化。
        let decisionClient = this.modelClient;
        let decisionModel = this.model;
        let fastDirectReply = false;
        if (this.dependencies.triage) {
          const verdict = await this.dependencies.triage.classify(
            await this.loadTriageContext(input.turnId, before.conversationId),
          );
          await recordAgentTurnEvent(this.db, {
            turnId: before.turnId,
            conversationId: before.conversationId,
            eventType: "triaged",
            payload: {
              route: verdict.route,
              tier: verdict.tier,
              reason: verdict.reason,
              degraded: verdict.degraded,
            },
          });
          if (verdict.route === "human") {
            await commitAgentTurnHandoff(this.db, {
              conversationId: before.conversationId,
              turnId: before.turnId,
              reason: "triage_high_risk",
            });
            return this.resultAfterExecution(before, resumed);
          }
          if (
            verdict.route === "auto" &&
            verdict.tier === "simple" &&
            !verdict.degraded &&
            this.dependencies.triage.fastClient &&
            this.dependencies.triage.fastModel
          ) {
            // 直答：同一 processAgentTurn 全套闸门，仅替换模型档位；
            // 若直答决策仍要求工具，下方恢复路径回到主力档执行。
            // 直答回复不续步（简单消息没有"还没干完"）——续步会把下一步
            // 决策升回主力档，违背直答的成本语义。
            decisionClient = this.dependencies.triage.fastClient;
            decisionModel = this.dependencies.triage.fastModel;
            fastDirectReply = true;
          }
        }
        const first = await processAgentTurn(
          this.db,
          decisionClient,
          decisionModel,
          input,
          { ...this.freshDependencies(), allowReplyContinuation: !fastDirectReply },
        );
        // 真 ReAct 统一步进循环：首轮决策后，tool_planned → 工具恢复，
        // running + continue 信号（reply 不带 wait_ms 续步）→ 下一步决策。
        await this.runStepLoop(input, turnService, first.continueLoop);
      }
    }

    return this.resultAfterExecution(before, resumed);
  }

  public async conversationIdFor(turnId: string): Promise<string> {
    const turn = await this.loadTurn(turnId);
    if (!turn) throw new Error(`agent turn ${turnId} does not exist`);
    return turn.conversationId;
  }

  /** fresh 决策路径的依赖子集（triage 直答档只在首轮生效，续步回主力档）。 */
  private freshDependencies() {
    return {
      ...(this.dependencies.knowledgeSearch
        ? { knowledgeSearch: this.dependencies.knowledgeSearch }
        : {}),
      ...(this.dependencies.skillRegistry
        ? { skillRegistry: this.dependencies.skillRegistry }
        : {}),
      ...(this.dependencies.strategyRegistry
        ? { strategyRegistry: this.dependencies.strategyRegistry }
        : {}),
      ...(this.dependencies.preResolveAiEmployeePrompt
        ? {
            preResolveAiEmployeePrompt:
              this.dependencies.preResolveAiEmployeePrompt,
          }
        : {}),
      ...(this.dependencies.resolveAiEmployeeId
        ? { resolveAiEmployeeId: this.dependencies.resolveAiEmployeeId }
        : {}),
      ...(this.dependencies.behaviorSettings
        ? { behaviorSettings: this.dependencies.behaviorSettings }
        : {}),
    };
  }

  /**
   * 真 ReAct 统一步进循环（调用方已完成首步并传入 continue 信号）：
   * - tool_planned → CAS 认领 → processPlannedToolTurn（工具恢复路径）；
   * - running 且上步 continue（reply/ask 不带 wait_ms 的续步）→
   *   processAgentTurn 走下一步决策（上下文含刚发出的消息）；
   * - 终态 / 认领失败 / 无 continue 信号 → 结束。
   * 这里的 MAX_IN_PROCESS_STEPS 只是失控防御；真实预算由 disposition
   * 代码持有（decisionStepBudget / toolStepBudget / replyStepBudget）。
   */
  private async runStepLoop(
    input: AgentTurnExecutionInput,
    turnService: AgentTurnService,
    continueLoop: boolean,
  ): Promise<void> {
    const MAX_IN_PROCESS_STEPS = 24;
    for (let step = 0; step < MAX_IN_PROCESS_STEPS; step += 1) {
      const current = await this.loadTurn(input.turnId);
      if (!current || isTerminal(current.status)) return;
      if (current.status === "tool_planned") {
        const claimed = await turnService.claim(input.turnId, this.model, [
          "tool_planned",
        ]);
        if (!claimed.applied) return;
        await recordAgentTurnEvent(this.db, {
          turnId: input.turnId,
          conversationId: current.conversationId,
          eventType: "execution_resumed",
          payload: { sourceStatus: "tool_planned" },
        });
        const result = await processPlannedToolTurn(
          this.db,
          this.modelClient,
          this.model,
          input,
          this.dependencies,
        );
        continueLoop = result.continueLoop;
        continue;
      }
      if (current.status !== "running" || !continueLoop) return;
      const result = await processAgentTurn(
        this.db,
        this.modelClient,
        this.model,
        input,
        this.freshDependencies(),
      );
      continueLoop = result.continueLoop;
    }
  }

  private async loadTurn(turnId: string) {
    const rows = await this.db
      .select({
        turnId: schema.agentTurns.turnId,
        conversationId: schema.agentTurns.conversationId,
        status: schema.agentTurns.status,
      })
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, turnId))
      .limit(1);
    return rows[0];
  }

  private async loadToolExecution(turnId: string) {
    const rows = await this.db
      .select({
        executionId: schema.toolExecutions.executionId,
        status: schema.toolExecutions.status,
        leaseUntil: schema.toolExecutions.leaseUntil,
      })
      .from(schema.toolExecutions)
      .where(eq(schema.toolExecutions.turnId, turnId))
      // 多步 ReAct 同 turn 多条计划；租约判断取最新一条
      .orderBy(
        desc(schema.toolExecutions.createdAt),
        desc(schema.toolExecutions.executionId),
      )
      .limit(1);
    return rows[0];
  }

  /** 加载预判分流所需的触发消息与近期入站文本（查询失败视为无上下文）。 */
  private async loadTriageContext(
    turnId: string,
    conversationId: string,
  ): Promise<{
    triggerText: string;
    recentInboundTexts: string[];
  }> {
    try {
      const [turn] = await this.db
        .select({ triggerMessageId: schema.agentTurns.triggerMessageId })
        .from(schema.agentTurns)
        .where(eq(schema.agentTurns.turnId, turnId))
        .limit(1);
      const triggerMessageId = turn?.triggerMessageId;
      const [trigger] = triggerMessageId
        ? await this.db
            .select({ text: schema.messages.text })
            .from(schema.messages)
            .where(eq(schema.messages.messageId, triggerMessageId))
            .limit(1)
        : [];
      const recent = await this.db
        .select({ text: schema.messages.text })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.conversationId, conversationId),
            eq(schema.messages.direction, "inbound"),
          ),
        )
        .orderBy(desc(schema.messages.occurredAt))
        .limit(5);
      return {
        triggerText: trigger?.text ?? "",
        recentInboundTexts: recent.map((row) => row.text).reverse(),
      };
    } catch {
      return { triggerText: "", recentInboundTexts: [] };
    }
  }

  private async resultAfterExecution(
    before: { turnId: string; conversationId: string; status: string },
    resumed: boolean,
  ): Promise<AgentTurnExecutionResult> {
    const after = await this.loadTurn(before.turnId);
    return {
      turnId: before.turnId,
      conversationId: after?.conversationId ?? before.conversationId,
      status: normalizeStatus(after?.status ?? before.status),
      resumed,
    };
  }
}

/** 根据轮次 ID 查询所属会话 ID（公共 API，保持向后兼容） */
export { getAgentTurnConversationId } from "./turn-utils.js";
