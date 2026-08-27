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
import type {
  KnowledgeSearch,
} from "../../knowledge/contracts/knowledge-search.js";
import type { SkillRegistry } from "../contracts/agent-skill.js";
import type { ExecutionStrategyRegistry } from "../contracts/execution-strategy.js";
import { AgentTurnService } from "./agent-turn-service.js";
import { recordAgentTurnEvent } from "./agent-turn-events.js";
import { processAgentTurn, processPlannedToolTurn } from "./turn-runner.js";
import {
  commitAgentTurnHandoff,
} from "./agent-turn-outcome-command.js";
import type { TriageVerdict } from "./triage-classifier.js";
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
       */
      preResolveAiEmployeePrompt?: (
        contactId: string,
        conversationId: string,
      ) => Promise<void>;
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
        payload: { sourceStatus: before.status },
      });
      await processPlannedToolTurn(
        this.db,
        this.modelClient,
        this.model,
        input.turnId,
        input.traceId,
        this.dependencies.knowledgeSearch,
        this.dependencies.skillRegistry,
        this.dependencies.strategyRegistry,
        this.dependencies.preResolveAiEmployeePrompt,
      );
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
        await processPlannedToolTurn(
          this.db,
          this.modelClient,
          this.model,
          input.turnId,
          input.traceId,
          this.dependencies.knowledgeSearch,
          this.dependencies.skillRegistry,
          this.dependencies.strategyRegistry,
          this.dependencies.preResolveAiEmployeePrompt,
        );
      } else {
        // 预判分流：规则 + 极速 LLM 分类，高危转人工 / simple 走直答档。
        // classify 内部 fail-open 永不抛错；未注入 triage 时零行为变化。
        let decisionClient = this.modelClient;
        let decisionModel = this.model;
        if (this.dependencies.triage) {
          const verdict = await this.dependencies.triage.classify(
            await this.loadTriageContext(
              input.turnId,
              before.conversationId,
            ),
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
            decisionClient = this.dependencies.triage.fastClient;
            decisionModel = this.dependencies.triage.fastModel;
          }
        }
        await processAgentTurn(this.db, decisionClient, decisionModel, input, {
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
            ? { preResolveAiEmployeePrompt: this.dependencies.preResolveAiEmployeePrompt }
            : {}),
        });

        const afterDecision = await this.loadTurn(input.turnId);
        if (afterDecision?.status === "tool_planned") {
          const toolStageClaim = await turnService.claim(
            input.turnId,
            this.model,
            ["tool_planned"],
          );
          if (toolStageClaim.applied) {
            await recordAgentTurnEvent(this.db, {
              turnId: before.turnId,
              conversationId: before.conversationId,
              eventType: "execution_resumed",
              payload: { sourceStatus: "tool_planned" },
            });
            await processPlannedToolTurn(
              this.db,
              this.modelClient,
              this.model,
              input.turnId,
              input.traceId,
              this.dependencies.knowledgeSearch,
              this.dependencies.skillRegistry,
              this.dependencies.strategyRegistry,
              this.dependencies.preResolveAiEmployeePrompt,
            );
          }
        }
      }
    }

    return this.resultAfterExecution(before, resumed);
  }

  public async conversationIdFor(turnId: string): Promise<string> {
    const turn = await this.loadTurn(turnId);
    if (!turn) throw new Error(`agent turn ${turnId} does not exist`);
    return turn.conversationId;
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
