/**
 * decision-disposition 单元测试。
 *
 * 重点钉住 Phase 1 重构中的有意顺序归一：fresh 路径的 superseded 检查
 * 先于工具计划构建——已被取代的旧轮次不再消耗工具计划校验。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../modules/agent/application/agent-turn-outcome-command.js", () => ({
  commitAgentTurnFailure: vi.fn(async () => undefined),
  commitAgentTurnHandoff: vi.fn(async () => ({ status: "committed" })),
  commitAgentTurnNoAction: vi.fn(async () => ({ status: "suppressed_policy" })),
  commitAgentTurnOutcome: vi.fn(async () => ({ status: "committed" })),
  commitAgentTurnSuperseded: vi.fn(async () => undefined),
  persistAgentToolCheckpoint: vi.fn(async () => ({ status: "planned" })),
}));

vi.mock("../modules/agent/application/turn-utils.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../modules/agent/application/turn-utils.js")
  >()),
  hasNewerAgentTurn: vi.fn(async () => true),
}));

import {
  commitDecisionDisposition,
  memoryWatermarkMessageId,
} from "../modules/agent/application/decision-disposition.js";
import {
  commitAgentTurnFailure,
  commitAgentTurnNoAction,
  commitAgentTurnOutcome,
  commitAgentTurnSuperseded,
  persistAgentToolCheckpoint,
} from "../modules/agent/application/agent-turn-outcome-command.js";
import { hasNewerAgentTurn } from "../modules/agent/application/turn-utils.js";
import type { AgentDecision } from "../modules/agent/application/agent-decision.js";
import * as schema from "../infrastructure/postgres/schema.js";

const dbMock = {
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  onConflictDoNothing: vi.fn(function (this: unknown) {
    const chain: any = {
      returning: vi.fn().mockResolvedValue([{ id: "scheduled:turn-test" }]),
    };
    chain.where = vi.fn(function (this: unknown) {
      return Promise.resolve([]);
    });
    return chain;
  }),
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockImplementation(() => {
    const p = Promise.resolve([]);
    return Object.assign(p, {
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    });
  }),
  orderBy: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([]),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockResolvedValue(undefined),
};
// 既有测试以 db 传参并断言调用；Phase 3 wait 分支需要 db 支持 insert
const db = dbMock as unknown as never;
const dbAsRecord = dbMock as unknown as {
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
};

function baseInput(overrides?: {
  path?: "fresh" | "tool_recovery";
  triggerMessageId?: string | undefined;
  conversationRevision?: number | null;
  decision?: AgentDecision;
  toolStepsUsed?: number;
  toolStepBudget?: number;
  scheduledSend?: {
    enabled: boolean;
    maxPending: number;
    maxPerDay: number;
    quietStartHour: number;
    quietEndHour: number;
  };
}) {
  const decision: AgentDecision = overrides?.decision ?? {
    replySegments: [],
    replyText: "",
    nextAction: "retrieve_knowledge",
    noActionReason: undefined,
    requiresHuman: false,
    riskLevel: "low",
    tool: undefined,
    knowledgeQuery: "如何恢复隔离文件",
    handoffBriefing: undefined,
    waitMs: undefined,
    scheduledMessage: undefined,
    scheduledSendAt: undefined,
    nudgeText: undefined,
    closureSummary: undefined,
  };
  return {
    db,
    decision,
    turnId: "turn-test",
    conversationId: "conv-test",
    traceId: "trace-test",
    path: overrides?.path ?? ("fresh" as const),
    triggerMessageId: overrides?.triggerMessageId,
    conversationRevision: overrides?.conversationRevision ?? 0,
    model: "test-model",
    aiEmployeeId: null,
    toolStepsUsed: overrides?.toolStepsUsed,
    toolStepBudget: overrides?.toolStepBudget,
    scheduledSend: overrides?.scheduledSend,
  };
}

describe("memoryWatermarkMessageId", () => {
  it("fresh 路径格式与既有落库值逐字节一致", () => {
    expect(memoryWatermarkMessageId("turn-1", "fresh", 2)).toBe(
      "agent-message:turn-1:2",
    );
  });

  it("tool_recovery 路径带 tool-result 段", () => {
    expect(memoryWatermarkMessageId("turn-1", "tool_recovery", 3)).toBe(
      "agent-message:turn-1:tool-result:3",
    );
  });
});

describe("commitDecisionDisposition fresh path ordering", () => {
  it("已被取代的轮次在工具计划构建前即终止（superseded 优先）", async () => {
    vi.mocked(hasNewerAgentTurn).mockResolvedValue(true);
    vi.mocked(commitAgentTurnSuperseded).mockClear();
    vi.mocked(persistAgentToolCheckpoint).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({ triggerMessageId: "msg-1" }),
    );

    expect(result).toEqual({ action: "terminal" });
    expect(hasNewerAgentTurn).toHaveBeenCalledWith(db, {
      turnId: "turn-test",
      conversationId: "conv-test",
      triggerMessageId: "msg-1",
    });
    expect(commitAgentTurnSuperseded).toHaveBeenCalledTimes(1);
    expect(commitAgentTurnSuperseded).toHaveBeenCalledWith(db, {
      conversationId: "conv-test",
      turnId: "turn-test",
      reason: "newer_turn_exists",
    });
    // 关键顺序断言：superseded 命中时不构建也不落工具检查点
    expect(persistAgentToolCheckpoint).not.toHaveBeenCalled();
    expect(commitAgentTurnOutcome).not.toHaveBeenCalled();
  });

  it("无更新轮次时正常进入工具检查点", async () => {
    vi.mocked(hasNewerAgentTurn).mockResolvedValue(false);
    vi.mocked(persistAgentToolCheckpoint).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({ triggerMessageId: "msg-1" }),
    );

    expect(result.action).toBe("checkpoint");
    expect(persistAgentToolCheckpoint).toHaveBeenCalledTimes(1);
    expect(commitAgentTurnOutcome).not.toHaveBeenCalled();
  });

  it("tool_recovery 路径不做 superseded 检查（无 triggerMessageId）", async () => {
    vi.mocked(hasNewerAgentTurn).mockClear();
    vi.mocked(commitAgentTurnOutcome).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({
        path: "tool_recovery",
        conversationRevision: null,
        decision: {
          replySegments: ["已为您查询到处理方法。"],
          replyText: "已为您查询到处理方法。",
          nextAction: "reply",
          noActionReason: undefined,
          requiresHuman: false,
          riskLevel: "low",
          tool: undefined,
          knowledgeQuery: undefined,
          handoffBriefing: undefined,
          waitMs: undefined,
          scheduledMessage: undefined,
          scheduledSendAt: undefined,
          nudgeText: undefined,
          closureSummary: undefined,
        },
      }),
    );

    expect(result).toEqual({ action: "terminal" });
    expect(hasNewerAgentTurn).not.toHaveBeenCalled();
    // tool_recovery 的 reply 决策直接落 outcome（variant=tool_result）
    expect(commitAgentTurnOutcome).toHaveBeenCalledTimes(1);
    expect(commitAgentTurnOutcome).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        variant: "tool_result",
        turnId: "turn-test",
      }),
    );
  });
});

describe("commitDecisionDisposition Phase 2 branches", () => {
  it("fresh wait 决策：走 NoAction 落库（reason=waiting_for_user），不落 outcome/工具检查点", async () => {
    vi.mocked(hasNewerAgentTurn).mockResolvedValue(false);
    vi.mocked(commitAgentTurnNoAction).mockClear();
    vi.mocked(commitAgentTurnOutcome).mockClear();
    vi.mocked(persistAgentToolCheckpoint).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({
        triggerMessageId: "msg-1",
        decision: {
          replySegments: [],
          replyText: "",
          nextAction: "wait",
          noActionReason: undefined,
          requiresHuman: false,
          riskLevel: "low",
          tool: undefined,
          knowledgeQuery: undefined,
          handoffBriefing: undefined,
          waitMs: 300_000,
          scheduledMessage: undefined,
          scheduledSendAt: undefined,
          nudgeText: "您先忙，有问题随时叫我",
          closureSummary: undefined,
        },
      }),
    );

    expect(result).toEqual({ action: "terminal" });
    expect(commitAgentTurnNoAction).toHaveBeenCalledWith(db, {
      conversationId: "conv-test",
      turnId: "turn-test",
      reason: "waiting_for_user",
    });
    // Phase 3：wait 决策必须落会话唤醒计划（wakeAt=now+waitMs，带 nudge）
    expect(dbAsRecord.insert).toHaveBeenCalledWith(expect.anything());
    expect(dbAsRecord.values).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-test",
        turnId: "turn-test",
        kind: "wait_timeout",
        status: "scheduled",
        nudgeText: "您先忙，有问题随时叫我",
        wakeAt: expect.any(Date),
      }),
    );
    expect(commitAgentTurnOutcome).not.toHaveBeenCalled();
    expect(persistAgentToolCheckpoint).not.toHaveBeenCalled();
  });

  it("fresh end_session 决策：直接落 outcome 收尾，不建工具检查点", async () => {
    vi.mocked(hasNewerAgentTurn).mockResolvedValue(false);
    vi.mocked(commitAgentTurnNoAction).mockClear();
    vi.mocked(commitAgentTurnOutcome).mockClear();
    vi.mocked(persistAgentToolCheckpoint).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({
        triggerMessageId: "msg-1",
        decision: {
          replySegments: [],
          replyText: "",
          nextAction: "end_session",
          noActionReason: undefined,
          requiresHuman: false,
          riskLevel: "low",
          tool: undefined,
          knowledgeQuery: undefined,
          handoffBriefing: undefined,
          waitMs: undefined,
          scheduledMessage: undefined,
          scheduledSendAt: undefined,
          nudgeText: undefined,
          closureSummary: "退款问题已解答，客户确认等待到账",
        },
      }),
    );

    expect(result).toEqual({ action: "terminal" });
    expect(commitAgentTurnOutcome).toHaveBeenCalledTimes(1);
    expect(commitAgentTurnOutcome).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        variant: "direct",
        turnId: "turn-test",
      }),
    );
    expect(persistAgentToolCheckpoint).not.toHaveBeenCalled();
  });
});

describe("commitDecisionDisposition tool step budget", () => {
  function toolDecision(): AgentDecision {
    return {
      replySegments: [],
      replyText: "",
      nextAction: "retrieve_knowledge",
      noActionReason: undefined,
      requiresHuman: false,
      riskLevel: "low",
      tool: undefined,
      knowledgeQuery: "二次检索：退款政策",
      handoffBriefing: undefined,
      waitMs: undefined,
    scheduledMessage: undefined,
    scheduledSendAt: undefined,
      nudgeText: undefined,
      closureSummary: undefined,
    };
  }

  it("预算未耗尽时 tool_recovery 允许再次规划工具（checkpoint 续跑）", async () => {
    vi.mocked(commitAgentTurnFailure).mockClear();
    vi.mocked(persistAgentToolCheckpoint).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({
        path: "tool_recovery",
        conversationRevision: null,
        decision: toolDecision(),
        toolStepsUsed: 1,
        toolStepBudget: 4,
      }),
    );

    expect(result.action).toBe("checkpoint");
    expect(persistAgentToolCheckpoint).toHaveBeenCalledTimes(1);
    expect(commitAgentTurnFailure).not.toHaveBeenCalled();
  });

  it("预算耗尽时 tool_recovery 工具决策落 tool_chain_limit 失败转人工", async () => {
    vi.mocked(commitAgentTurnFailure).mockClear();
    vi.mocked(persistAgentToolCheckpoint).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({
        path: "tool_recovery",
        conversationRevision: null,
        decision: toolDecision(),
        toolStepsUsed: 4,
        toolStepBudget: 4,
      }),
    );

    expect(result).toEqual({ action: "terminal" });
    expect(commitAgentTurnFailure).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ errorCode: "tool_chain_limit" }),
    );
    expect(persistAgentToolCheckpoint).not.toHaveBeenCalled();
  });
});

describe("commitDecisionDisposition — schedule_send（定时发送）", () => {
  it("开关开启且护栏内：落 scheduled_sends 计划 + created 事件，无确认回复按 NoAction 收尾", async () => {
    vi.mocked(hasNewerAgentTurn).mockResolvedValue(false);
    vi.mocked(commitAgentTurnNoAction).mockClear();
    vi.mocked(commitAgentTurnOutcome).mockClear();
    dbAsRecord.insert.mockClear();

    const decision = {
      replySegments: [],
      replyText: "",
      nextAction: "schedule_send",
      noActionReason: undefined,
      requiresHuman: false,
      riskLevel: "low",
      tool: undefined,
      knowledgeQuery: undefined,
      handoffBriefing: undefined,
      waitMs: undefined,
      nudgeText: undefined,
      scheduledMessage: "明早 9 点提醒您续费",
      scheduledSendAt: new Date(Date.now() + 60 * 60_000),
      closureSummary: undefined,
    } as AgentDecision;

    const result = await commitDecisionDisposition(
      baseInput({
        triggerMessageId: "msg-1",
        decision,
        scheduledSend: {
          enabled: true,
          maxPending: 2,
          maxPerDay: 10,
          quietStartHour: 22,
          quietEndHour: 8,
        },
      }),
    );

    expect(result).toEqual({ action: "terminal" });
    const insertedTables = dbAsRecord.insert.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(insertedTables).toContain(
      schema.scheduledSends,
    );
    expect(commitAgentTurnOutcome).not.toHaveBeenCalled();
    expect(commitAgentTurnNoAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "scheduled_send" }),
    );
  });

  it("开关关闭：压制定时（不落计划），按 NoAction 收尾", async () => {
    vi.mocked(hasNewerAgentTurn).mockResolvedValue(false);
    vi.mocked(commitAgentTurnNoAction).mockClear();
    dbAsRecord.insert.mockClear();

    const decision = {
      replySegments: [],
      replyText: "",
      nextAction: "schedule_send",
      noActionReason: undefined,
      requiresHuman: false,
      riskLevel: "low",
      tool: undefined,
      knowledgeQuery: undefined,
      handoffBriefing: undefined,
      waitMs: undefined,
      nudgeText: undefined,
      scheduledMessage: "明早提醒",
      scheduledSendAt: new Date(Date.now() + 60 * 60_000),
      closureSummary: undefined,
    } as AgentDecision;

    await commitDecisionDisposition(
      baseInput({
        triggerMessageId: "msg-1",
        decision,
        scheduledSend: {
          enabled: false,
          maxPending: 2,
          maxPerDay: 10,
          quietStartHour: 22,
          quietEndHour: 8,
        },
      }),
    );

    const insertedTables = dbAsRecord.insert.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(insertedTables).not.toContain(
      schema.scheduledSends,
    );
    expect(commitAgentTurnNoAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "scheduled_send" }),
    );
  });
});
