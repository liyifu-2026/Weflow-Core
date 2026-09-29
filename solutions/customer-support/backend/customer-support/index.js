/**
 * Customer Support backend plugin (BFF).
 *
 * Loaded by the Weflow Core backend plugin loader at runtime. Provides the
 * business HTTP surface: AI employee admin (definitions / versions /
 * workspace default / contact bindings) and read-only session projections
 * (session state, decision trace, turn outcomes, wakes, live turn).
 */
import { createAiEmployeesService } from "./ai-employees-service.js";

// ---------------------------------------------------------------------------
// 部署种子（ADR-0011：业务缺省出引擎）。引擎缺省一律中立/空；本产品的
// 业务缺省在 BFF 注册时幂等种入扩展设置（solution.extension_settings，
// scope=weflow.customer-support / key=support-pipeline 行）。只补缺失键，
// 绝不覆盖用户已配置值；种子失败仅告警，不阻断插件注册。
// 种子值 = 引擎曾内置的业务缺省逐字节拷贝（本部署模型可见字节不变）。
// ---------------------------------------------------------------------------
const SETTINGS_SCOPE = "weflow.customer-support";
const SETTINGS_KEY = "support-pipeline";
const SEED_SETTINGS = {
  groupChat: {
    mode: "mention_only",
    botNames: ["客服"],
  },
  pipeline: {
    triage: {
      systemPrompt:
        "你是客服消息预判器。根据最新一条客户消息判断它应如何路由，只输出一个 JSON 对象：" +
        '{"route":"auto","tier":"simple","reason":"不超过20字"} 。' +
        "判定规则：" +
        "route=human 表示建议转人工：客户情绪激烈、问题明显超出自动客服能力、或明确要求人工；" +
        "route=auto 表示可以自动回复。" +
        "tier=simple 仅当消息只是寒暄问候、简单确认或纯情绪安抚，不需要任何业务知识即可得体回复；" +
        "其余一律 tier=standard。" +
        "除该 JSON 外不要输出任何其他内容。",
    },
  },
  // 决策模型（System One）问题集与阈值：开关默认全关，影子期数据校准后才
  // 逐项打开（评审方案 96.5/100）。q_* 键名是引擎契约（decision-triage.ts
  // DECISION_QUESTION_IDS），instructions/criteria 文本属业务话术可自由调整。
  decision: {
    shadowEnabled: false,
    triageEnabled: false,
    worthReplyEnabled: false,
    timeoutMs: 500,
    thresholds: {
      humanProbability: 0.85,
      humanConfidence: 0.6,
      simpleProbability: 0.8,
      noReplyProbability: 0.9,
    },
    questions: {
      q_need_human: {
        type: "noul",
        instructions:
          "判断该客户最新消息是否需要转给人工客服处理。需要转人工的情形：" +
          "客户情绪激烈或明确表达不满、涉及退款赔偿等敏感诉求、问题明显超出自动客服能力、" +
          "客户明确要求人工服务。普通咨询、寒暄、简单确认都不需要转人工。",
      },
      q_tier: {
        type: "choice",
        instructions:
          "判断该客户消息适合哪种处理档位。simple=寒暄问候、简单确认或纯情绪安抚，" +
          "不需要业务知识即可得体回复；standard=涉及产品、订单、售后等需要业务知识的实质问题。",
        criteria: {
          simple: "寒暄/问候/简单确认/纯情绪安抚",
          standard: "需要业务知识的实质问题",
          other: "无法判断",
        },
      },
      q_worth_reply: {
        type: "noul",
        instructions:
          "判断该消息是否需要客服作出回应。需要回应的情形：包含问题、诉求、情绪表达或" +
          "对客服上条消息的实质反馈。不需要回应的情形：纯表情、语气词（如\"哦\"\"哈哈\"）、" +
          "无实义的闲聊碎片。拿不准时视为需要回应。",
      },
      q_urgency: {
        type: "score",
        instructions:
          "给该客户问题的紧急程度打分（转人工后坐席按分值优先处理）。" +
          "分值越高越需要尽快人工介入：情绪激烈、涉及退款赔偿、问题持续恶化、客户明确限期处理" +
          "都应打高分；一般咨询、可等待的问题打中低分。",
        criteria: ["1 很不紧急", "2 不紧急", "3 一般", "4 比较紧急", "5 非常紧急"],
      },
      q_finished: {
        type: "noul",
        instructions:
          "判断该客户最近几条消息想表达的内容是否已经说完整。" +
          "说完整的情形：一句话表达了完整的诉求/问题/回应，即使带情绪也算完整。" +
          "没说完的情形：话说一半（如\"我买的那个东西\"后就停住）、明显在等对方回应、" +
          "或在逐条补充信息。拿不准时视为已说完。",
      },
      q_has_memory: {
        type: "noul",
        instructions:
          "判断这批客户消息里是否包含值得长期记住的客户事实或偏好" +
          "（如购买记录、使用环境、个人习惯、明确承诺等）。" +
          "纯寒暄、情绪宣泄、临时性对话都不值得记。拿不准时视为值得记。",
      },
    },
  },
  behavior: {
    roundSummaryLabels: { customer: "客户", agent: "客服" },
  },
};

/** 只补缺失键的深合并：已存在的任何值（含空串/false）一律不动。 */
function fillMissingKeys(target, seed) {
  let changed = false;
  for (const [key, value] of Object.entries(seed)) {
    const current = target[key];
    if (current === undefined) {
      target[key] = value;
      changed = true;
    } else if (
      value !== null && typeof value === "object" && !Array.isArray(value) &&
      current !== null && typeof current === "object" && !Array.isArray(current)
    ) {
      if (fillMissingKeys(current, value)) changed = true;
    }
  }
  return changed;
}

async function ensureSeedDefaults(ctx) {
  const updatedBy = "customer-support-seed";
  try {
    const result = await ctx.db.execute(
      ctx.sql`SELECT settings_json FROM solution.extension_settings
              WHERE scope = ${SETTINGS_SCOPE} AND key = ${SETTINGS_KEY}`,
    );
    const rows = result.rows ?? [];
    if (rows.length === 0) {
      await ctx.db.execute(
        ctx.sql`INSERT INTO solution.extension_settings
                (scope, key, settings_json, updated_by, updated_at)
                VALUES (${SETTINGS_SCOPE}, ${SETTINGS_KEY},
                        ${JSON.stringify(SEED_SETTINGS)}::jsonb,
                        ${updatedBy}, now())`,
      );
      return;
    }
    const merged = JSON.parse(JSON.stringify(rows[0].settings_json ?? {}));
    if (!fillMissingKeys(merged, SEED_SETTINGS)) return;
    await ctx.db.execute(
      ctx.sql`UPDATE solution.extension_settings
              SET settings_json = ${JSON.stringify(merged)}::jsonb,
                  updated_by = ${updatedBy}, updated_at = now()
              WHERE scope = ${SETTINGS_SCOPE} AND key = ${SETTINGS_KEY}`,
    );
  } catch (error) {
    console.warn(
      "[customer-support] seed defaults skipped:",
      error?.message ?? error,
    );
  }
}

export async function registerRoutes(server, ctx) {
  const { db, schema, eq, desc } = ctx;
  // 种子先于通道事件摄取生效：BFF 注册（api 进程启动）早于 Channel Host 拉起
  await ensureSeedDefaults(ctx);
  const aiEmployeesService = createAiEmployeesService(ctx);

  async function requireUser(request, reply) {
    const identity = await ctx.requireBusinessIdentity(ctx.db, request, reply);
    return identity ?? undefined;
  }

  // -------- AI Employees (definitions, versions, workspace default, bindings) -------

  function sendServiceResult(reply, result, okStatus) {
    if (!result || result.status === "ok") {
      reply.code(okStatus ?? 200);
      return reply.send(result ?? { status: "ok" });
    }
    const codes = {
      invalid_request: 400,
      ai_employee_key_exists: 409,
      ai_employee_not_found: 404,
      ai_employee_not_editable: 409,
      ai_employee_not_archivable: 409,
      ai_employee_not_versionable: 409,
      ai_employee_version_not_editable: 409,
      ai_employee_version_not_publishable: 409,
      ai_employee_version_not_rollbackable: 409,
      ai_employee_default_invalid: 400,
      contact_agent_binding_invalid: 400,
    };
    return reply
      .code(codes[result.status] ?? 400)
      .send({ error: result.status, reason: result.reason });
  }

  server.get("/api/v1/agent/ai-employees", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    return aiEmployeesService.listDefinitions();
  });

  server.post("/api/v1/agent/ai-employees", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.user.role !== "admin") {
      return reply.code(403).send({ error: "admin_required" });
    }
    const body = request.body ?? {};
    const result = await aiEmployeesService.createDefinition({
      key: body.key,
      name: body.name,
      description: body.description ?? null,
      prompt: body.prompt,
    });
    if (result.status !== "ok") return sendServiceResult(reply, result);
    reply.code(201);
    return reply.send(result);
  });

  server.patch("/api/v1/agent/ai-employees/:definitionId", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.user.role !== "admin") {
      return reply.code(403).send({ error: "admin_required" });
    }
    const definitionId = String(request.params?.definitionId ?? "");
    const result = await aiEmployeesService.updateDefinition(
      definitionId,
      request.body ?? {},
    );
    if (result.status !== "ok") return sendServiceResult(reply, result);
    return reply.send(result);
  });

  server.post(
    "/api/v1/agent/ai-employees/:definitionId/archive",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      if (user.user.role !== "admin") {
        return reply.code(403).send({ error: "admin_required" });
      }
      const definitionId = String(request.params?.definitionId ?? "");
      const result = await aiEmployeesService.archiveDefinition(definitionId);
      if (result.status !== "ok") return sendServiceResult(reply, result);
      return reply.send(result);
    },
  );

  server.post(
    "/api/v1/agent/ai-employees/:definitionId/versions",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      if (user.user.role !== "admin") {
        return reply.code(403).send({ error: "admin_required" });
      }
      const definitionId = String(request.params?.definitionId ?? "");
      const body = request.body ?? {};
      const result = await aiEmployeesService.createVersion(definitionId, body.prompt);
      if (result.status !== "ok") return sendServiceResult(reply, result);
      reply.code(201);
      return reply.send(result);
    },
  );

  server.patch(
    "/api/v1/agent/ai-employees/versions/:versionId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      if (user.user.role !== "admin") {
        return reply.code(403).send({ error: "admin_required" });
      }
      const versionId = String(request.params?.versionId ?? "");
      const body = request.body ?? {};
      const result = await aiEmployeesService.updateVersion(versionId, body.prompt);
      if (result.status !== "ok") return sendServiceResult(reply, result);
      return reply.send(result);
    },
  );

  server.post(
    "/api/v1/agent/ai-employees/versions/:versionId/publish",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      if (user.user.role !== "admin") {
        return reply.code(403).send({ error: "admin_required" });
      }
      const versionId = String(request.params?.versionId ?? "");
      const result = await aiEmployeesService.publishVersion(versionId);
      if (result.status !== "ok") return sendServiceResult(reply, result);
      return reply.send(result);
    },
  );

  server.post(
    "/api/v1/agent/ai-employees/versions/:versionId/rollback",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      if (user.user.role !== "admin") {
        return reply.code(403).send({ error: "admin_required" });
      }
      const versionId = String(request.params?.versionId ?? "");
      const result = await aiEmployeesService.rollbackVersion(versionId);
      if (result.status !== "ok") return sendServiceResult(reply, result);
      return reply.send(result);
    },
  );

  server.get("/api/v1/agent/workspace-default", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    return aiEmployeesService.getWorkspaceDefault();
  });

  server.put("/api/v1/agent/workspace-default", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.user.role !== "admin") {
      return reply.code(403).send({ error: "admin_required" });
    }
    const body = request.body ?? {};
    await aiEmployeesService.setWorkspaceDefault(body.definitionId ?? null);
    return aiEmployeesService.getWorkspaceDefault();
  });

  server.get("/api/v1/agent/contact-bindings", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    return aiEmployeesService.listContactBindings();
  });

  server.put(
    "/api/v1/agent/contact-bindings/:contactId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const contactId = String(request.params?.contactId ?? "");
      const body = request.body ?? {};
      const result = await aiEmployeesService.setContactBinding(
        contactId,
        body.definitionId,
      );
      if (result.status !== "ok") return sendServiceResult(reply, result);
      return reply.send(result);
    },
  );

  server.delete(
    "/api/v1/agent/contact-bindings/:contactId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const contactId = String(request.params?.contactId ?? "");
      await aiEmployeesService.removeContactBinding(contactId);
      return { ok: true };
    },
  );

  // ── 会话模式可视化（Phase 3/4 只读投影）──────────────────────────
  // 会话状态（session episode）：接待中/等待/已收尾 + 预算计数
  server.get(
    "/api/v1/agent/session-state/:conversationId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const conversationId = String(request.params?.conversationId ?? "");
      const [session] = await db
        .select({
          sessionId: schema.agentSessions.sessionId,
          state: schema.agentSessions.state,
          roundsUsed: schema.agentSessions.roundsUsed,
          roundBudget: schema.agentSessions.roundBudget,
          startedAt: schema.agentSessions.startedAt,
          closedAt: schema.agentSessions.closedAt,
          closureSummary: schema.agentSessions.closureSummary,
        })
        .from(schema.agentSessions)
        .where(eq(schema.agentSessions.conversationId, conversationId))
        .orderBy(desc(schema.agentSessions.startedAt))
        .limit(1);
      return { session: session ?? null };
    },
  );

  /** decision-trace 工具结果截断：超 2000 字符截断并标注（字符串/JSON 对象都兜住） */
  function truncateTraceResult(value) {
    if (value === null || value === undefined) return value;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined || text.length <= 2000) return value;
    if (typeof value === "string") return `${text.slice(0, 2000)}…（已截断）`;
    // 对象截断后保持对象形状，前端 jsonPreview 仍按 JSON 渲染
    return { truncated: true, preview: `${text.slice(0, 2000)}…（已截断）` };
  }

  // 决策轨迹：turn_events 的可读投影（不含模型思维链）+ 工具执行记录联表
  //（参数/结果在 tool_executions 表，事件流里只有工具名和成败）
  server.get(
    "/api/v1/agent/decision-trace/:turnId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const turnId = String(request.params?.turnId ?? "");
      const events = await db
        .select({
          eventType: schema.agentTurnEvents.eventType,
          reasonCode: schema.agentTurnEvents.reasonCode,
          payload: schema.agentTurnEvents.payload,
          createdAt: schema.agentTurnEvents.createdAt,
        })
        .from(schema.agentTurnEvents)
        .where(eq(schema.agentTurnEvents.turnId, turnId))
        .orderBy(schema.agentTurnEvents.createdAt);
      // 与注释承诺对齐：model_reasoning（模型思维链）不对坐席端返回，
      // 过滤掉而不是靠调用方自行忽略（此前无 eventType 过滤会原样泄漏）。
      const visibleEvents = events.filter(
        (event) => event.eventType !== "model_reasoning",
      );
      const toolExecutions = await db
        .select({
          executionId: schema.toolExecutions.executionId,
          toolName: schema.toolExecutions.toolName,
          status: schema.toolExecutions.status,
          errorCode: schema.toolExecutions.errorCode,
          arguments: schema.toolExecutions.arguments,
          result: schema.toolExecutions.result,
          createdAt: schema.toolExecutions.createdAt,
          completedAt: schema.toolExecutions.completedAt,
        })
        .from(schema.toolExecutions)
        .where(eq(schema.toolExecutions.turnId, turnId))
        .orderBy(schema.toolExecutions.createdAt);
      // 工具结果可能很大：截断到 2000 字符（参数保留，坐席排查需要入参原貌）
      const safeToolExecutions = toolExecutions.map((row) => ({
        ...row,
        result: truncateTraceResult(row.result),
      }));
      const [turn] = await db
        .select({
          turnId: schema.agentTurns.turnId,
          status: schema.agentTurns.status,
          model: schema.agentTurns.model,
          errorCode: schema.agentTurns.errorCode,
          responseSegments: schema.agentTurns.responseSegments,
          traceId: schema.agentTurns.traceId,
          startedAt: schema.agentTurns.startedAt,
          completedAt: schema.agentTurns.completedAt,
        })
        .from(schema.agentTurns)
        .where(eq(schema.agentTurns.turnId, turnId))
        .limit(1);
      return {
        turn: turn ?? null,
        events: visibleEvents,
        toolExecutions: safeToolExecutions,
      };
    },
  );

  // 轮次体检：最近 N 轮的 结果分类/耗时/错误码 + 孤儿入站消息（未触发轮次）。
  // 目标：30 秒内分辨「已回复 / 已读不回 / 失败 / 没收到」四类问题。
  server.get(
    "/api/v1/agent/turn-outcomes/:conversationId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const conversationId = String(request.params?.conversationId ?? "");
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const turns = await db
        .select({
          turnId: schema.agentTurns.turnId,
          status: schema.agentTurns.status,
          errorCode: schema.agentTurns.errorCode,
          startedAt: schema.agentTurns.startedAt,
          completedAt: schema.agentTurns.completedAt,
          triggerMessageId: schema.agentTurns.triggerMessageId,
        })
        .from(schema.agentTurns)
        .where(eq(schema.agentTurns.conversationId, conversationId))
        .orderBy(desc(schema.agentTurns.createdAt))
        .limit(30);

      const turnIds = turns.map((t) => t.turnId);
      // 回复落库事件携带 replyBatchId → 前端用它把结束气泡钉在该轮最后一条回复后
      const replyEvents = turnIds.length
        ? await db
            .select({
              turnId: schema.agentTurnEvents.turnId,
              payload: schema.agentTurnEvents.payload,
            })
            .from(schema.agentTurnEvents)
            .where(eq(schema.agentTurnEvents.eventType, "reply_persisted"))
            .orderBy(desc(schema.agentTurnEvents.createdAt))
            .limit(200)
        : [];
      const replyBatchByTurn = new Map(
        replyEvents
          .filter((e) => turnIds.includes(e.turnId) && e.payload?.replyBatchId)
          .map((e) => [e.turnId, String(e.payload.replyBatchId)]),
      );

      const outcomeOf = (t) => {
        if (t.status === "completed") return "replied";
        if (t.status === "failed") return "failed";
        if (
          t.status === "suppressed_policy" ||
          t.status === "suppressed_handoff" ||
          t.status === "no_action" ||
          t.status === "superseded"
        )
          return "no_reply";
        return "in_flight";
      };

      const outcomes = turns.map((t) => ({
        turnId: t.turnId,
        status: t.status,
        errorCode: t.errorCode ?? null,
        startedAt: t.startedAt?.toISOString?.() ?? t.startedAt ?? null,
        completedAt: t.completedAt?.toISOString?.() ?? t.completedAt ?? null,
        durationMs:
          t.startedAt && t.completedAt
            ? new Date(t.completedAt) - new Date(t.startedAt)
            : null,
        triggerMessageId: t.triggerMessageId ?? null,
        replyBatchId: replyBatchByTurn.get(t.turnId) ?? null,
        outcome: outcomeOf(t),
      }));

      // 孤儿入站：24h 内的入站消息中没有成为任何 turn 触发者的部分
      const inbound = await db
        .select({
          messageId: schema.messages.messageId,
          direction: schema.messages.direction,
          contentType: schema.messages.contentType,
          text: schema.messages.text,
          occurredAt: schema.messages.occurredAt,
        })
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, conversationId))
        .orderBy(desc(schema.messages.occurredAt))
        .limit(100);
      const triggered = new Set(
        turns.map((t) => t.triggerMessageId).filter(Boolean),
      );
      // 孤儿判定用 24h 全量 trigger 集合（outcomes 只取最近 30 轮，不够覆盖）
      const recentTriggers = await db
        .select({ triggerMessageId: schema.agentTurns.triggerMessageId })
        .from(schema.agentTurns)
        .where(eq(schema.agentTurns.conversationId, conversationId))
        .orderBy(desc(schema.agentTurns.createdAt))
        .limit(300);
      for (const t of recentTriggers) {
        if (t.triggerMessageId) triggered.add(t.triggerMessageId);
      }
      const orphans = inbound
        .filter(
          (m) =>
            m.direction === "inbound" &&
            !triggered.has(m.messageId) &&
            new Date(m.occurredAt) >= since,
        )
        .slice(0, 20)
        .map((m) => ({
          messageId: m.messageId,
          contentType: m.contentType,
          text: (m.text ?? "").slice(0, 60),
          occurredAt: m.occurredAt?.toISOString?.() ?? m.occurredAt,
        }));

      const counts = { replied: 0, no_reply: 0, failed: 0, in_flight: 0 };
      for (const o of outcomes) counts[o.outcome] += 1;

      return {
        counts,
        outcomes,
        orphans,
        orphanCount: orphans.length,
      };
    },
  );

  // 会话级唤醒计划（wait 时间线节点的数据源）
  server.get(
    "/api/v1/agent/session-wakes/:conversationId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const conversationId = String(request.params?.conversationId ?? "");
      const wakes = await db
        .select({
          wakeId: schema.sessionWakes.wakeId,
          turnId: schema.sessionWakes.turnId,
          kind: schema.sessionWakes.kind,
          status: schema.sessionWakes.status,
          wakeAt: schema.sessionWakes.wakeAt,
          nudgeText: schema.sessionWakes.nudgeText,
        })
        .from(schema.sessionWakes)
        .where(eq(schema.sessionWakes.conversationId, conversationId))
        .orderBy(desc(schema.sessionWakes.wakeAt))
        .limit(20);
      return { wakes };
    },
  );

  // 进行中的 Agent Turn（轮询源：产生「AI 正在思考」的体感）
  server.get(
    "/api/v1/agent/live-turn/:conversationId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const conversationId = String(request.params?.conversationId ?? "");
      const [turn] = await db
        .select({
          turnId: schema.agentTurns.turnId,
          status: schema.agentTurns.status,
          startedAt: schema.agentTurns.startedAt,
          createdAt: schema.agentTurns.createdAt,
        })
        .from(schema.agentTurns)
        .where(eq(schema.agentTurns.conversationId, conversationId))
        .orderBy(desc(schema.agentTurns.createdAt))
        .limit(1);
      // live 判定收口（THINKING 修复）：只有 queued/running 算"处理中"，
      // failed / suppressed_* / completed / superseded 全部是终态——否则
      // 失败或被压制的最新轮次会让"正在处理"气泡永远挂着。
      const LIVE_EXCLUDED = new Set([
        "completed",
        "superseded",
        "failed",
        "suppressed_handoff",
        "suppressed_policy",
      ]);
      if (!turn || LIVE_EXCLUDED.has(turn.status)) {
        return { live: null };
      }
      // stale 防线：queued/running 超过 5 分钟（worker 挂掉/重启遗留）
      // 不再报告 live——绝不产生"永远转圈"。
      const STALE_RUNNING_MS = 5 * 60 * 1000;
      const startedAtMs = new Date(turn.startedAt ?? turn.createdAt).getTime();
      if (Number.isFinite(startedAtMs) && Date.now() - startedAtMs > STALE_RUNNING_MS) {
        return { live: null, stale: true };
      }
      const events = await db
        .select({
          eventType: schema.agentTurnEvents.eventType,
          reasonCode: schema.agentTurnEvents.reasonCode,
          payload: schema.agentTurnEvents.payload,
          createdAt: schema.agentTurnEvents.createdAt,
        })
        .from(schema.agentTurnEvents)
        .where(eq(schema.agentTurnEvents.turnId, turn.turnId))
        .orderBy(schema.agentTurnEvents.createdAt);
      const lastEvent = events.at(-1) ?? null;
      const reasoning =
        [...events].reverse().find((e) => e.eventType === "model_reasoning")
          ?.payload?.reasoning ?? null;
      return {
        live: {
          turnId: turn.turnId,
          status: turn.status,
          startedAt: turn.startedAt ?? turn.createdAt,
          lastEvent: lastEvent
            ? {
                eventType: lastEvent.eventType,
                reasonCode: lastEvent.reasonCode,
                createdAt: lastEvent.createdAt,
              }
            : null,
          reasoning,
        },
      };
    },
  );
}
