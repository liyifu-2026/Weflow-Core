/**
 * Triage 预判分流测试。
 *
 * Part A（单元）：classifyForTriage 的规则层 / LLM 层 / 兜底降级分支。
 * Part B（集成，需 TEST_DATABASE_URL）：AgentTurnExecutor 分流编排——
 * human 转人工、simple 直答走 fast 档、未注入 triage 时行为不变。
 */

import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { OpenAiCompatibleClient } from "../infrastructure/model_runtime/openai-compatible-client.js";
import { AgentTurnExecutor } from "../modules/agent/application/agent-turn-executor.js";
import {
  classifyForTriage,
  DEFAULT_TRIAGE_POLICY,
  extractTriagePolicy,
  type TriagePolicy,
} from "../modules/agent/application/triage-classifier.js";

/** 构造 OpenAI 兼容 fake 客户端：每次调用返回给定 content */
function fakeClient(
  contents: string[],
  onCall?: () => void,
): OpenAiCompatibleClient {
  let call = 0;
  return new OpenAiCompatibleClient({
    baseUrl: "https://model.invalid",
    apiKey: "test-only",
    model: "fake",
    timeoutMs: 1_000,
    fetch: () => {
      const content = contents[Math.min(call, contents.length - 1)];
      call += 1;
      onCall?.();
      return Promise.resolve(
        Response.json({ choices: [{ message: { content } }] }),
      );
    },
  });
}

const POLICY_BASE: TriagePolicy = {
  enabled: true,
  riskKeywords: [],
  llmClassifyEnabled: true,
  timeoutMs: 3_000,
  allowDirectReply: false,
};

describe("classifyForTriage (unit)", () => {
  it("policy 关闭时整层短路放行且零模型调用", async () => {
    let calls = 0;
    const client = fakeClient(["{}"], () => {
      calls += 1;
    });
    const verdict = await classifyForTriage({
      policy: { ...POLICY_BASE, enabled: false },
      client,
      model: "fake",
      triggerText: "退款",
    });
    expect(verdict).toEqual({
      route: "auto",
      tier: "standard",
      reason: "triage_pass_through",
      degraded: false,
    });
    expect(calls).toBe(0);
  });

  it("风险关键词命中直接转人工（不调 LLM）", async () => {
    let calls = 0;
    const client = fakeClient([], () => {
      calls += 1;
    });
    const verdict = await classifyForTriage({
      policy: { ...POLICY_BASE, riskKeywords: ["退款", "投诉"] },
      client,
      model: "fake",
      triggerText: "我要退款，现在就退！",
    });
    expect(verdict.route).toBe("human");
    expect(verdict.reason).toBe("risk_keyword_hit:退款");
    expect(calls).toBe(0);
  });

  it("LLM 判定为 simple 时输出 simple 档", async () => {
    const client = fakeClient([
      JSON.stringify({ route: "auto", tier: "simple", reason: "寒暄问候" }),
    ]);
    const verdict = await classifyForTriage({
      policy: POLICY_BASE,
      client,
      model: "fake",
      triggerText: "你好呀",
    });
    expect(verdict.route).toBe("auto");
    expect(verdict.tier).toBe("simple");
    expect(verdict.degraded).toBe(false);
  });

  it("LLM 垃圾输出时 fail-open 放行并标记 degraded", async () => {
    const verdict = await classifyForTriage({
      policy: POLICY_BASE,
      client: fakeClient(["这不是 JSON"]),
      model: "fake",
      triggerText: "帮我查一下订单",
    });
    expect(verdict).toEqual({
      route: "auto",
      tier: "standard",
      reason: "triage_llm_failed_or_timeout",
      degraded: true,
    });
  });

  it("分类异常/超时时 fail-open 且标记 degraded", async () => {
    const verdict = await classifyForTriage({
      policy: { ...POLICY_BASE, timeoutMs: 500 },
      client: new OpenAiCompatibleClient({
        baseUrl: "https://model.invalid",
        apiKey: "test-only",
        model: "fake",
        timeoutMs: 1_000,
        fetch: () => new Promise(() => undefined), // hang → 触发判定超时
      }),
      model: "fake",
      triggerText: "帮我查一下订单",
    });
    expect(verdict.degraded).toBe(true);
    expect(verdict.route).toBe("auto");
  });

  it("extractTriagePolicy 对畸形输入逐项回落默认值", () => {
    expect(extractTriagePolicy(undefined)).toEqual(DEFAULT_TRIAGE_POLICY);
    expect(extractTriagePolicy({ pipeline: {} })).toMatchObject({
      enabled: false,
      allowDirectReply: false,
    });
    const parsed = extractTriagePolicy({
      pipeline: {
        triage: {
          enabled: true,
          riskKeywords: ["退款", "", null],
          timeoutMs: 99999,
          allowDirectReply: true,
        },
      },
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.riskKeywords).toEqual(["退款"]);
    expect(parsed.timeoutMs).toBe(DEFAULT_TRIAGE_POLICY.timeoutMs);
    expect(parsed.allowDirectReply).toBe(true);
  });

  it("extractTriagePolicy 忽略接待编排新增字段（notes/defaultEmployeeKey/employeeRoutes）", () => {
    const parsed = extractTriagePolicy({
      pipeline: {
        triage: { enabled: true, riskKeywords: ["投诉"] },
        notes: { triage: "说明", gate: "永不旁路" },
        defaultEmployeeKey: "after-sales",
        employeeRoutes: [
          { id: "route-1", keywords: ["退货"], employeeKey: "after-sales" },
        ],
      },
    });
    expect(parsed).toEqual({
      ...DEFAULT_TRIAGE_POLICY,
      enabled: true,
      riskKeywords: ["投诉"],
    });
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("AgentTurnExecutor triage orchestration", () => {
  let postgres: Postgres;
  let mainModelCalls = 0;
  let fastModelCalls = 0;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  // 每个用例独立会话：一个用例创建 handoff 会激活 agentPaused，
  // 复用同一会话会让后续 turn 被回策略压制。

  /** 创建独立会话并返回针对该会话的数据助手 */
  async function createScenario(name: string) {
    const conversationId = `channel:triage-${name}-${suffix}`;
    const contactId = `contact:channel:triage-${name}-${suffix}`;
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `${name}-${suffix}`,
      // 允许自动回复：evaluateReplyPolicy / commit 阶段都会检查该开关
      agentEnabled: true,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `${name}-${suffix}`,
    });
    return {
      conversationId,
      insertMessage: (messageId: string, text: string) =>
        postgres.db.insert(schema.messages).values({
          messageId,
          conversationId,
          direction: "inbound" as const,
          actorType: "channel_contact",
          contentType: "text",
          channelType: 1,
          text,
          processingState: "received",
          idempotencyKey: messageId,
          occurredAt: new Date(),
          traceId: messageId,
        }),
      insertTurn: (turnId: string, triggerMessageId: string) =>
        postgres.db
          .insert(schema.agentTurns)
          .values({
            turnId,
            triggerMessageId,
            conversationId,
            status: "queued",
            traceId: turnId,
          })
          .onConflictDoNothing(),
    };
  }

  const mainClient = (contents: string[] = ["主力档回复"]) => {
    let call = 0;
    return new OpenAiCompatibleClient({
      baseUrl: "https://model.invalid",
      apiKey: "test-only",
      model: "main-fake",
      timeoutMs: 1_000,
      fetch: () => {
        const content = contents[Math.min(call, contents.length - 1)];
        call += 1;
        mainModelCalls += 1;
        return Promise.resolve(
          Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    next_action: "reply",
                    reply_text: content,
                    requires_human: false,
                    risk_level: "low",
                  }),
                },
              },
            ],
          }),
        );
      },
    });
  };

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "triage-test"),
    );
  });

  afterAll(async () => {
    // FK 依赖顺序：events → states → cycles → turns → messages → conversations
    await postgres.db
      .delete(schema.handoffEvents)
      .where(like(schema.handoffEvents.conversationId, "channel:triage-%"));
    await postgres.db
      .delete(schema.handoffStates)
      .where(like(schema.handoffStates.conversationId, "channel:triage-%"));
    await postgres.db
      .delete(schema.handoffCycles)
      .where(like(schema.handoffCycles.conversationId, "channel:triage-%"));
    await postgres.db
      .delete(schema.agentTurnEvents)
      .where(like(schema.agentTurnEvents.turnId, "triage-%"));
    await postgres.db
      .delete(schema.agentTurns)
      .where(like(schema.agentTurns.turnId, "triage-%"));
    await postgres.db
      .delete(schema.memoryCaptureStates)
      .where(like(schema.memoryCaptureStates.conversationId, "channel:triage-%"));
    await postgres.db
      .delete(schema.messages)
      .where(like(schema.messages.conversationId, "channel:triage-%"));
    await postgres.db
      .delete(schema.notificationOutbox)
      .where(like(schema.notificationOutbox.conversationId, "channel:triage-%"));
    await postgres.db
      .delete(schema.conversations)
      .where(like(schema.conversations.conversationId, "channel:triage-%"));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(like(schema.contactProfiles.contactId, "contact:channel:triage-%"));
    await postgres.close();
  });

  /** 组装 executor：classifier 直接注入给定的判定结果 */
  const executorWithClassifier = (
    verdict: Awaited<ReturnType<typeof classifyForTriage>>,
    extra?: { fastContent?: string; mainContents?: string[] },
  ) => {
    mainModelCalls = 0;
    fastModelCalls = 0;
    return new AgentTurnExecutor(
      postgres.db,
      mainClient(extra?.mainContents ?? ["主力档回复"]),
      "main-fake",
      {
      triage: {
        classify: async () => verdict,
        ...(extra?.fastContent
          ? {
              fastClient: fakeClient([extra.fastContent], () => {
                fastModelCalls += 1;
              }),
              fastModel: "fast-fake",
            }
          : {}),
      },
    });
  };

  it("route=human 时转人工：不调用任何模型，落 triaged + handoff 事件", async () => {
    const scenario = await createScenario("human");
    const messageId = `triage-human-msg-${suffix}`;
    await scenario.insertMessage(messageId, "我要投诉你们的服务");
    const turnId = `triage-human-${suffix}`;
    await scenario.insertTurn(turnId, messageId);

    const result = await executorWithClassifier({
      route: "human",
      tier: "standard",
      reason: "risk_keyword_hit:投诉",
      degraded: false,
    }).execute({ turnId, traceId: turnId });

    expect(result.status).toBe("suppressed_handoff"); // AI 建议转人工：回复被抑制，会话进入待认领
    expect(mainModelCalls).toBe(0);

    const [turn] = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, turnId));
    expect(turn?.status).toBe("suppressed_handoff");

    const [handoff] = await postgres.db
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, scenario.conversationId));
    expect(handoff).toBeDefined();
    // 进入待认领队列，AI 出站被暂停
    expect(String(handoff?.status)).toBe("pending");
    expect(handoff?.agentPaused).toBeTruthy();

    const events = await postgres.db
      .select()
      .from(schema.agentTurnEvents)
      .where(eq(schema.agentTurnEvents.turnId, turnId));
    expect(events.map((event) => event.eventType)).toContain("triaged");
    expect(events.map((event) => event.eventType)).toContain(
      "handoff_created",
    );
  });

  it("simple+直答开启时走 fast 档：主力量零调用，回复经过全部闸门落库", async () => {
    const scenario = await createScenario("fast");
    const messageId = `triage-fast-msg-${suffix}`;
    await scenario.insertMessage(messageId, "你好呀");
    const turnId = `triage-fast-${suffix}`;
    await scenario.insertTurn(turnId, messageId);

    const result = await executorWithClassifier(
      {
        route: "auto",
        tier: "simple",
        reason: "寒暄问候",
        degraded: false,
      },
      {
        fastContent: JSON.stringify({
          next_action: "reply",
          reply_text: "您好呀，很高兴为您服务～",
          requires_human: false,
          risk_level: "low",
        }),
      },
    ).execute({ turnId, traceId: turnId });

    expect(result.status).toBe("completed");
    expect(fastModelCalls).toBeGreaterThan(0);
    expect(mainModelCalls).toBe(0);

    const events = await postgres.db
      .select()
      .from(schema.agentTurnEvents)
      .where(eq(schema.agentTurnEvents.turnId, turnId));
    expect(events.map((event) => event.eventType)).toContain("reply_persisted");
  });

  it("standard 判定回到主力档执行；degraded 放行绝不直答", async () => {
    const scenario = await createScenario("standard");
    const messageId = `triage-standard-msg-${suffix}`;
    await scenario.insertMessage(messageId, "我的设备连不上网了怎么办");
    const turnId = `triage-standard-${suffix}`;
    await scenario.insertTurn(turnId, messageId);

    const result = await executorWithClassifier({
      route: "auto",
      tier: "standard",
      reason: "需要产品知识",
      degraded: false,
    }).execute({ turnId, traceId: turnId });

    expect(result.status).toBe("completed");
    expect(mainModelCalls).toBeGreaterThan(0);

    // degraded 直答禁止路径：verdict.degraded=true 即使 tier=simple 也不启用 fast
    const messageId2 = `triage-degraded-msg-${suffix}`;
    await scenario.insertMessage(messageId2, "在吗");
    const turnId2 = `triage-degraded-${suffix}`;
    await scenario.insertTurn(turnId2, messageId2);

    const result2 = await executorWithClassifier(
      { route: "auto", tier: "simple", reason: "超时兜底", degraded: true },
      {
        fastContent: "{}",
        // 两次主力回复必须不同，否则会被 duplicate_reply 拦截（这是正常保护）
        mainContents: ["主力档回复一", "主力档回复二"],
      },
    ).execute({ turnId: turnId2, traceId: turnId2 });

    expect(result2.status).toBe("completed");
    expect(fastModelCalls).toBe(0);
    expect(mainModelCalls).toBeGreaterThan(0);
  });

  it("未注入 triage 依赖时保持原行为（直接主力档决策）", async () => {
    const scenario = await createScenario("off");
    const messageId = `triage-off-msg-${suffix}`;
    await scenario.insertMessage(messageId, "普通消息");
    const turnId = `triage-off-${suffix}`;
    await scenario.insertTurn(turnId, messageId);

    mainModelCalls = 0;
    fastModelCalls = 0;
    const result = await new AgentTurnExecutor(
      postgres.db,
      mainClient(),
      "main-fake",
      {},
    ).execute({ turnId, traceId: turnId });

    expect(result.status).toBe("completed");
    expect(mainModelCalls).toBeGreaterThan(0);

    const events = await postgres.db
      .select()
      .from(schema.agentTurnEvents)
      .where(
        and(
          eq(schema.agentTurnEvents.turnId, turnId),
          eq(schema.agentTurnEvents.eventType, "triaged"),
        ),
      );
    expect(events).toHaveLength(0);
  });
});
