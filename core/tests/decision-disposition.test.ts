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
  commitAgentTurnReplyStep: vi.fn(async () => ({
    status: "persisted",
    stepIndex: 1,
    replyBatchId: "agent-reply:turn-test:step:1",
  })),
  commitAgentTurnSuperseded: vi.fn(async () => undefined),
  completeAgentTurnAfterSteps: vi.fn(async () => undefined),
  countStepBatches: vi.fn(async () => 0),
  persistAgentToolCheckpoint: vi.fn(async () => ({ status: "planned" })),
}));

vi.mock(
  "../modules/agent/application/turn-utils.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../modules/agent/application/turn-utils.js")
    >()),
    findNewerActiveTurnIds: vi.fn(async () => []),
  }),
);

import {
  commitDecisionDisposition,
  absorbVerdictFor,
} from "../modules/agent/application/decision-disposition.js";
import {
  commitAgentTurnFailure,
  commitAgentTurnHandoff,
  commitAgentTurnNoAction,
  commitAgentTurnOutcome,
  commitAgentTurnReplyStep,
  commitAgentTurnSuperseded,
  countStepBatches,
  persistAgentToolCheckpoint,
} from "../modules/agent/application/agent-turn-outcome-command.js";
import { findNewerActiveTurnIds } from "../modules/agent/application/turn-utils.js";
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
    factsCard: undefined,
  };
  return {
    db,
    decision,
    turnId: "turn-test",
    conversationId: "conv-test",
    traceId: "trace-test",
    path: overrides?.path ?? ("fresh" as const),
    chatType: "private" as const,
    triggerMessageId: overrides?.triggerMessageId,
    conversationRevision: overrides?.conversationRevision ?? 0,
    model: "test-model",
    aiEmployeeId: null,
    toolStepsUsed: overrides?.toolStepsUsed,
    toolStepBudget: overrides?.toolStepBudget,
    scheduledSend: overrides?.scheduledSend,
  };
}

describe("commitDecisionDisposition fresh path ordering", () => {
  it("回合运行中收到插话：吸收标记 + 作废过时决策继续（不再处决自己）", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue(["turn-newer"]);
    vi.mocked(commitAgentTurnSuperseded).mockClear();
    vi.mocked(persistAgentToolCheckpoint).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({
        triggerMessageId: "msg-1",
        decision: {
          replySegments: ["重启一下试试。"],
          replyText: "重启一下试试。",
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
          factsCard: undefined,
        },
      }),
    );

    expect(result).toEqual({ action: "continue" });
    expect(findNewerActiveTurnIds).toHaveBeenCalledWith(db, {
      turnId: "turn-test",
      conversationId: "conv-test",
      triggerMessageId: "msg-1",
    });
    // 插话轮被标记 absorbed（superseded + 原因码），调度互斥防重复执行
    expect(commitAgentTurnSuperseded).toHaveBeenCalledWith(db, {
      conversationId: "conv-test",
      turnId: "turn-newer",
      reason: "absorbed_into:turn-test",
    });
    // 关键顺序断言：吸收命中的过时决策不构建也不落工具检查点
    expect(persistAgentToolCheckpoint).not.toHaveBeenCalled();
    expect(commitAgentTurnOutcome).not.toHaveBeenCalled();
  });

  it("无更新轮次时正常进入工具检查点", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue([]);
    vi.mocked(persistAgentToolCheckpoint).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({ triggerMessageId: "msg-1" }),
    );

    expect(result.action).toBe("checkpoint");
    expect(persistAgentToolCheckpoint).toHaveBeenCalledTimes(1);
    expect(commitAgentTurnOutcome).not.toHaveBeenCalled();
  });

  it("tool_recovery 路径不做 superseded 检查（无 triggerMessageId）", async () => {
    vi.mocked(findNewerActiveTurnIds).mockClear();
    vi.mocked(commitAgentTurnOutcome).mockClear();
    // 续步批数预算已耗尽（2/2）：无 wait_ms 的回复照常落 outcome 收口
    vi.mocked(countStepBatches).mockResolvedValue(2);

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
          factsCard: undefined,
        },
      }),
    );

    expect(result).toEqual({ action: "terminal" });
    expect(findNewerActiveTurnIds).not.toHaveBeenCalled();
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
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue([]);
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
          factsCard: undefined,
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

  it("fresh end_session 决策：无收尾话术按 no_action(session_closed) 静默收尾", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue([]);
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
          factsCard: undefined,
        },
      }),
    );

    expect(result).toEqual({ action: "terminal" });
    expect(commitAgentTurnNoAction).toHaveBeenCalledTimes(1);
    expect(commitAgentTurnNoAction).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ reason: "session_closed" }),
    );
    expect(commitAgentTurnOutcome).not.toHaveBeenCalled();
    expect(persistAgentToolCheckpoint).not.toHaveBeenCalled();
  });

  it("fresh end_session 决策：带收尾话术先落 outcome 再收尾，不建工具检查点", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue([]);
    vi.mocked(commitAgentTurnNoAction).mockClear();
    vi.mocked(commitAgentTurnOutcome).mockClear();
    vi.mocked(persistAgentToolCheckpoint).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({
        triggerMessageId: "msg-1",
        decision: {
          replySegments: ["有问题再找我。"],
          replyText: "有问题再找我。",
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
          closureSummary: "客户确认解决，主动收尾",
          factsCard: undefined,
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
        responseSegments: ["有问题再找我。"],
      }),
    );
    expect(commitAgentTurnNoAction).not.toHaveBeenCalled();
    expect(persistAgentToolCheckpoint).not.toHaveBeenCalled();
  });

  it("reply 携带 wait_ms：回复照常落库，并登记会话唤醒（说话并等待）", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue([]);
    vi.mocked(commitAgentTurnOutcome).mockClear();
    dbAsRecord.insert.mockClear();

    const result = await commitDecisionDisposition(
      baseInput({
        triggerMessageId: "msg-1",
        decision: {
          replySegments: ["先重启试试。"],
          replyText: "先重启试试。",
          nextAction: "reply",
          noActionReason: undefined,
          requiresHuman: false,
          riskLevel: "low",
          tool: undefined,
          knowledgeQuery: undefined,
          handoffBriefing: undefined,
          waitMs: 90_000,
          scheduledMessage: undefined,
          scheduledSendAt: undefined,
          nudgeText: "还在吗？",
          closureSummary: undefined,
          factsCard: undefined,
        },
      }),
    );

    expect(result).toEqual({ action: "terminal" });
    expect(commitAgentTurnOutcome).toHaveBeenCalledTimes(1);
    // scheduleSessionWake 经 db.insert(schema.sessionWakes) 落唤醒行
    expect(dbAsRecord.insert).toHaveBeenCalled();
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
      factsCard: undefined,
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

  // 2026-09-07 回归（可可猫群/私聊 395 双 5min 假死）：恢复路径对目录外
  // 工具名曾无 try/catch，getToolPlan 抛 tool_not_in_catalog 穿顶，
  // turn 卡 running 直到 STALE 兜底回收。必须优雅终态，不得抛出。
  it("tool_recovery 目录外工具名落 invalid_tool_plan 失败而非抛出（2026-09-07 回归）", async () => {
    vi.mocked(commitAgentTurnFailure).mockClear();
    vi.mocked(persistAgentToolCheckpoint).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({
        path: "tool_recovery",
        conversationRevision: null,
        decision: {
          ...toolDecision(),
          nextAction: "call_tool",
          tool: { name: "none", arguments: {} },
        },
        toolStepsUsed: 1,
        toolStepBudget: 4,
      }),
    );

    expect(result).toEqual({ action: "terminal" });
    expect(commitAgentTurnFailure).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ errorCode: "invalid_tool_plan" }),
    );
    expect(persistAgentToolCheckpoint).not.toHaveBeenCalled();
  });
});

describe("commitDecisionDisposition — schedule_send（定时发送）", () => {
  it("开关开启且护栏内：落 scheduled_sends 计划 + created 事件，无确认回复按 NoAction 收尾", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue([]);
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
      factsCard: undefined,
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
    expect(insertedTables).toContain(schema.scheduledSends);
    expect(commitAgentTurnOutcome).not.toHaveBeenCalled();
    expect(commitAgentTurnNoAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "scheduled_send" }),
    );
  });

  it("开关关闭：压制定时（不落计划），按 NoAction 收尾", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue([]);
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
      factsCard: undefined,
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
    expect(insertedTables).not.toContain(schema.scheduledSends);
    expect(commitAgentTurnNoAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "scheduled_send" }),
    );
  });
});

describe("commitDecisionDisposition — handoff 告别话术", () => {
  const handoffDecision = (
    overrides: Partial<AgentDecision>,
  ): AgentDecision => ({
    replySegments: [],
    replyText: "",
    nextAction: "handoff",
    noActionReason: undefined,
    requiresHuman: true,
    riskLevel: "medium",
    tool: undefined,
    knowledgeQuery: undefined,
    handoffBriefing: undefined,
    waitMs: undefined,
    scheduledMessage: undefined,
    scheduledSendAt: undefined,
    nudgeText: undefined,
    closureSummary: undefined,
    factsCard: undefined,
    ...overrides,
  });

  it("模型显式 handoff 携带告别语：farewellSegments 透传 commitAgentTurnHandoff", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue([]);
    vi.mocked(commitAgentTurnHandoff).mockClear();

    await commitDecisionDisposition(
      baseInput({
        triggerMessageId: "msg-1",
        decision: handoffDecision({
          replySegments: ["这个我帮你转同事看一下，稍等。", " "],
          replyText: "这个我帮你转同事看一下，稍等。",
        }),
      }),
    );

    expect(commitAgentTurnHandoff).toHaveBeenCalledTimes(1);
    const call = vi.mocked(commitAgentTurnHandoff).mock.calls[0]?.[1];
    expect(call).toMatchObject({
      conversationId: "conv-test",
      turnId: "turn-test",
      farewellSegments: ["这个我帮你转同事看一下，稍等。"],
    });
    expect(commitAgentTurnOutcome).not.toHaveBeenCalled();
  });

  it("requires_human 触发闸门（next_action=reply）：reply 文本不作为告别语代发", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue([]);
    vi.mocked(commitAgentTurnHandoff).mockClear();

    await commitDecisionDisposition(
      baseInput({
        triggerMessageId: "msg-1",
        decision: handoffDecision({
          nextAction: "reply",
          replySegments: ["这是被闸门拦下的回复内容。"],
          replyText: "这是被闸门拦下的回复内容。",
        }),
      }),
    );

    expect(commitAgentTurnHandoff).toHaveBeenCalledTimes(1);
    const call = vi.mocked(commitAgentTurnHandoff).mock.calls[0]?.[1];
    expect(call).not.toHaveProperty("farewellSegments");
  });

  it("handoff 无告别语：不传 farewellSegments（静默转接）", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue([]);
    vi.mocked(commitAgentTurnHandoff).mockClear();

    await commitDecisionDisposition(
      baseInput({
        triggerMessageId: "msg-1",
        decision: handoffDecision({}),
      }),
    );

    expect(commitAgentTurnHandoff).toHaveBeenCalledTimes(1);
    const call = vi.mocked(commitAgentTurnHandoff).mock.calls[0]?.[1];
    expect(call).not.toHaveProperty("farewellSegments");
  });
});

describe("commitDecisionDisposition — 真 ReAct 续步（reply 不带 wait_ms）", () => {
  const continueDecision = (): AgentDecision => ({
    replySegments: ["稍等，我看下后台。"],
    replyText: "稍等，我看下后台。",
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
    factsCard: undefined,
  });

  it("fresh：预算内续步落 reply_step（continue），不走 outcome", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue([]);
    vi.mocked(countStepBatches).mockResolvedValue(0);
    vi.mocked(commitAgentTurnReplyStep).mockClear();
    vi.mocked(commitAgentTurnOutcome).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({ triggerMessageId: "msg-1", decision: continueDecision() }),
    );

    expect(result).toEqual({ action: "continue" });
    expect(commitAgentTurnReplyStep).toHaveBeenCalledTimes(1);
    expect(commitAgentTurnReplyStep).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        conversationId: "conv-test",
        turnId: "turn-test",
        segments: ["稍等，我看下后台。"],
      }),
    );
    expect(commitAgentTurnOutcome).not.toHaveBeenCalled();
  });

  it("tool_recovery：预算内同样续步（continue）", async () => {
    vi.mocked(countStepBatches).mockResolvedValue(0);
    vi.mocked(commitAgentTurnReplyStep).mockClear();
    vi.mocked(commitAgentTurnOutcome).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({
        path: "tool_recovery",
        conversationRevision: null,
        decision: continueDecision(),
      }),
    );

    expect(result).toEqual({ action: "continue" });
    expect(commitAgentTurnReplyStep).toHaveBeenCalledTimes(1);
    expect(commitAgentTurnOutcome).not.toHaveBeenCalled();
  });

  it("续步批数预算耗尽：照常落 outcome 收口（terminal）", async () => {
    vi.mocked(countStepBatches).mockResolvedValue(2);
    vi.mocked(commitAgentTurnReplyStep).mockClear();
    vi.mocked(commitAgentTurnOutcome).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({ triggerMessageId: "msg-1", decision: continueDecision() }),
    );

    expect(result).toEqual({ action: "terminal" });
    expect(commitAgentTurnReplyStep).not.toHaveBeenCalled();
    expect(commitAgentTurnOutcome).toHaveBeenCalledTimes(1);
  });

  it("决策步数预算耗尽（decisionStepBudget=0）：照常落 outcome 收口", async () => {
    vi.mocked(countStepBatches).mockResolvedValue(0);
    vi.mocked(commitAgentTurnReplyStep).mockClear();
    vi.mocked(commitAgentTurnOutcome).mockClear();

    const input = {
      ...baseInput({ triggerMessageId: "msg-1", decision: continueDecision() }),
      decisionStepBudget: 0,
    };
    const result = await commitDecisionDisposition(input);

    expect(result).toEqual({ action: "terminal" });
    expect(commitAgentTurnReplyStep).not.toHaveBeenCalled();
    expect(commitAgentTurnOutcome).toHaveBeenCalledTimes(1);
  });

  it("续步被闸门压制（handoff_active）：terminal 收尾", async () => {
    vi.mocked(countStepBatches).mockResolvedValue(0);
    vi.mocked(commitAgentTurnReplyStep).mockResolvedValue({
      status: "suppressed_handoff",
      reason: "handoff_active",
    });
    vi.mocked(commitAgentTurnOutcome).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({ triggerMessageId: "msg-1", decision: continueDecision() }),
    );

    expect(result).toEqual({ action: "terminal" });
    expect(commitAgentTurnOutcome).not.toHaveBeenCalled();
    vi.mocked(commitAgentTurnReplyStep).mockResolvedValue({
      status: "persisted",
      stepIndex: 1,
      replyBatchId: "agent-reply:turn-test:step:1",
    });
  });

  it("带 wait_ms 的 reply 不续步（说话并等待，回合终）", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue([]);
    vi.mocked(countStepBatches).mockResolvedValue(0);
    vi.mocked(commitAgentTurnReplyStep).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({
        triggerMessageId: "msg-1",
        decision: { ...continueDecision(), waitMs: 90_000 },
      }),
    );

    expect(result).toEqual({ action: "terminal" });
    expect(commitAgentTurnReplyStep).not.toHaveBeenCalled();
  });
});

describe("commitDecisionDisposition — 工具动作附带过程短讯", () => {
  function toolDecisionWithNotes(segments: string[]): AgentDecision {
    return {
      replySegments: segments,
      replyText: segments.join("\n\n"),
      nextAction: "retrieve_knowledge",
      noActionReason: undefined,
      requiresHuman: false,
      riskLevel: "low",
      tool: undefined,
      knowledgeQuery: "导出失败 排查",
      handoffBriefing: undefined,
      waitMs: undefined,
      scheduledMessage: undefined,
      scheduledSendAt: undefined,
      nudgeText: undefined,
      closureSummary: undefined,
      factsCard: undefined,
    };
  }

  it("≤2 条短讯透传 noteSegments，检查点照常落", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue([]);
    vi.mocked(persistAgentToolCheckpoint).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({
        triggerMessageId: "msg-1",
        decision: toolDecisionWithNotes(["稍等，我看下后台。"]),
      }),
    );

    expect(result.action).toBe("checkpoint");
    expect(persistAgentToolCheckpoint).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        noteSegments: ["稍等，我看下后台。"],
        traceId: "trace-test",
      }),
    );
  });

  it("无短讯：noteSegments 为空数组，行为与改造前一致", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue([]);
    vi.mocked(persistAgentToolCheckpoint).mockClear();

    await commitDecisionDisposition(
      baseInput({
        triggerMessageId: "msg-1",
        decision: toolDecisionWithNotes([]),
      }),
    );

    expect(persistAgentToolCheckpoint).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ noteSegments: [] }),
    );
  });

  it(">2 条短讯：软闸丢弃 + tool_note_suppressed 事件，工具照常执行", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue([]);
    vi.mocked(persistAgentToolCheckpoint).mockClear();
    dbAsRecord.insert.mockClear();

    const result = await commitDecisionDisposition(
      baseInput({
        triggerMessageId: "msg-1",
        decision: toolDecisionWithNotes(["一", "二", "三"]),
      }),
    );

    expect(result.action).toBe("checkpoint");
    expect(persistAgentToolCheckpoint).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ noteSegments: [] }),
    );
    // tool_note_suppressed 事件经 recordAgentTurnEvent 落库
    const insertedTables = dbAsRecord.insert.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(insertedTables).toContain(schema.agentTurnEvents);
  });
});

describe("commitDecisionDisposition — 群聊禁续步（2026-09-07 三连发回归）", () => {
  const groupReplyDecision = (): AgentDecision => ({
    replySegments: ["看到了，有事说事"],
    replyText: "看到了，有事说事",
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
    factsCard: undefined,
  });

  it("群聊 reply 无 wait_ms：不续步，照常落 outcome 收口", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue([]);
    vi.mocked(countStepBatches).mockResolvedValue(0);
    vi.mocked(commitAgentTurnReplyStep).mockClear();
    vi.mocked(commitAgentTurnOutcome).mockClear();

    const input = {
      ...baseInput({ triggerMessageId: "msg-1", decision: groupReplyDecision() }),
      conversationId: "channel:wxid_test:45740750295@chatroom",
      chatType: "group" as const, // ADR-0010：会话类型由调用方透传事实
    };
    const result = await commitDecisionDisposition(input);

    expect(result).toEqual({ action: "terminal" });
    expect(commitAgentTurnReplyStep).not.toHaveBeenCalled();
    expect(commitAgentTurnOutcome).toHaveBeenCalledTimes(1);
  });

  it("群聊 chatType 事实（ADR-0010）：透传 group 即禁续步，不再按 ID 推断", async () => {
    vi.mocked(countStepBatches).mockResolvedValue(0);
    vi.mocked(commitAgentTurnReplyStep).mockClear();
    vi.mocked(commitAgentTurnOutcome).mockClear();

    const result = await commitDecisionDisposition({
      ...baseInput({ triggerMessageId: "msg-1", decision: groupReplyDecision() }),
      conversationId: "channel:x:room@chatroom",
      chatType: "group" as const, // 必填 Channel 事实（turn-runner 从 conversations.chat_type 透传）
    });

    expect(result).toEqual({ action: "terminal" });
    expect(commitAgentTurnReplyStep).not.toHaveBeenCalled();
    vi.mocked(countStepBatches).mockResolvedValue(0);
  });
});

describe("absorbVerdictFor 吸收策略矩阵", () => {
  const decisionOf = (
    nextAction: AgentDecision["nextAction"],
    replySegments: string[] = [],
  ): AgentDecision => ({
    replySegments,
    replyText: replySegments.join("\n\n"),
    nextAction,
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
    factsCard: undefined,
  });

  it("fresh：生命周期决策（reply/ask/no_action/wait）一律 discard（可由含插话的新决策再生）", () => {
    expect(absorbVerdictFor("fresh", decisionOf("reply", ["旧回复"]))).toBe(
      "discard",
    );
    expect(
      absorbVerdictFor("fresh", decisionOf("ask_for_information", ["追问"])),
    ).toBe("discard");
    expect(absorbVerdictFor("fresh", decisionOf("no_action"))).toBe("discard");
    expect(absorbVerdictFor("fresh", decisionOf("wait"))).toBe("discard");
  });

  it("fresh：查证/定时/收线 carry-through（意图对新上下文仍有效）", () => {
    expect(absorbVerdictFor("fresh", decisionOf("retrieve_knowledge"))).toBe(
      "carry-through",
    );
    expect(absorbVerdictFor("fresh", decisionOf("call_tool"))).toBe(
      "carry-through",
    );
    expect(absorbVerdictFor("fresh", decisionOf("schedule_send"))).toBe(
      "carry-through",
    );
    expect(absorbVerdictFor("fresh", decisionOf("end_session"))).toBe(
      "carry-through",
    );
  });

  it("tool_recovery：携带工具结论的 reply/ask → commit-as-step（结论只活在恢复决策里，丢弃即丢失）", () => {
    expect(
      absorbVerdictFor("tool_recovery", decisionOf("reply", ["查询结果：…"])),
    ).toBe("commit-as-step");
    expect(
      absorbVerdictFor("tool_recovery", decisionOf("ask_for_information", ["…"])),
    ).toBe("commit-as-step");
  });

  it("tool_recovery：无段的 reply/ask 与 no_action/wait 仍 discard", () => {
    expect(absorbVerdictFor("tool_recovery", decisionOf("reply"))).toBe(
      "discard",
    );
    expect(absorbVerdictFor("tool_recovery", decisionOf("no_action"))).toBe(
      "discard",
    );
    expect(absorbVerdictFor("tool_recovery", decisionOf("wait"))).toBe(
      "discard",
    );
    expect(absorbVerdictFor("tool_recovery", decisionOf("end_session"))).toBe(
      "carry-through",
    );
  });
});

describe("吸收式回合·恢复路径（commit-as-step 格子，2026-09-09 前零测试）", () => {
  const replyDecision: AgentDecision = {
    replySegments: ["已为您查到隔离文件的恢复方法。"],
    replyText: "已为您查到隔离文件的恢复方法。",
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
    factsCard: undefined,
  };

  it("恢复决策携带工具结论 + 客户插话：reply 以 step 落库并继续（不丢结论、不直接落 outcome）", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue(["turn-newer"]);
    vi.mocked(commitAgentTurnSuperseded).mockClear();
    vi.mocked(commitAgentTurnReplyStep).mockClear();
    vi.mocked(commitAgentTurnOutcome).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({
        path: "tool_recovery",
        conversationRevision: null,
        triggerMessageId: "msg-1",
        decision: replyDecision,
      }),
    );

    expect(result).toEqual({ action: "continue" });
    // 插话轮标记 absorbed，调度互斥防重复执行
    expect(commitAgentTurnSuperseded).toHaveBeenCalledWith(db, {
      conversationId: "conv-test",
      turnId: "turn-newer",
      reason: "absorbed_into:turn-test",
    });
    // 关键断言：回复以 step 落库（携带工具结论），turn 保持 running
    expect(commitAgentTurnReplyStep).toHaveBeenCalledTimes(1);
    expect(commitAgentTurnReplyStep).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        turnId: "turn-test",
        segments: replyDecision.replySegments,
      }),
    );
    expect(commitAgentTurnOutcome).not.toHaveBeenCalled();
  });

  it("恢复决策为 no_action + 插话：作废继续（discard 格子）", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue(["turn-newer"]);
    vi.mocked(commitAgentTurnNoAction).mockClear();
    vi.mocked(commitAgentTurnReplyStep).mockClear();
    vi.mocked(commitAgentTurnOutcome).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({
        path: "tool_recovery",
        conversationRevision: null,
        triggerMessageId: "msg-1",
        decision: { ...replyDecision, nextAction: "no_action" },
      }),
    );

    expect(result).toEqual({ action: "continue" });
    expect(commitAgentTurnReplyStep).not.toHaveBeenCalled();
    expect(commitAgentTurnNoAction).not.toHaveBeenCalled();
    expect(commitAgentTurnOutcome).not.toHaveBeenCalled();
  });
});

describe("恢复路径 wait / end_session 分支（2026-09-09 修复：此前落空回复/不关会话）", () => {
  it("tool_recovery wait 决策：NoAction(waiting_for_user) + 唤醒计划，不落 outcome", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue([]);
    vi.mocked(commitAgentTurnNoAction).mockClear();
    vi.mocked(commitAgentTurnOutcome).mockClear();
    vi.mocked(persistAgentToolCheckpoint).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({
        path: "tool_recovery",
        conversationRevision: null,
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
          waitMs: 60_000,
          scheduledMessage: undefined,
          scheduledSendAt: undefined,
          nudgeText: undefined,
          closureSummary: undefined,
          factsCard: undefined,
        },
      }),
    );

    expect(result).toEqual({ action: "terminal" });
    expect(commitAgentTurnNoAction).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ reason: "waiting_for_user" }),
    );
    expect(commitAgentTurnOutcome).not.toHaveBeenCalled();
    expect(persistAgentToolCheckpoint).not.toHaveBeenCalled();
  });

  it("tool_recovery end_session 带收尾话术：落 outcome（variant=tool_result）并关会话", async () => {
    vi.mocked(findNewerActiveTurnIds).mockResolvedValue([]);
    vi.mocked(commitAgentTurnNoAction).mockClear();
    vi.mocked(commitAgentTurnOutcome).mockClear();

    const result = await commitDecisionDisposition(
      baseInput({
        path: "tool_recovery",
        conversationRevision: null,
        decision: {
          replySegments: ["本次排查就到这里，有问题随时找我。"],
          replyText: "本次排查就到这里，有问题随时找我。",
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
          closureSummary: "问题已解决",
          factsCard: undefined,
        },
      }),
    );

    expect(result).toEqual({ action: "terminal" });
    expect(commitAgentTurnOutcome).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ variant: "tool_result" }),
    );
    expect(commitAgentTurnNoAction).not.toHaveBeenCalled();
  });
});
