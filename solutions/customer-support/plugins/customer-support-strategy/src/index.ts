import type {
  AgentAction,
  AgentExecutionStrategy,
  AgentStrategyContext,
} from "@weflow-leaif/contracts";
import {
  customerSupportSystemPrompt,
  aiEmployeeSystemPrompt,
} from "./prompt.js";
import { DEFAULT_REPLY_WAIT_MS } from "./decision-protocol.js";
import {
  parseCustomerSupportResponse,
  type ParseCustomerSupportOptions,
} from "./parser.js";

/**
 * 安装的 contracts@1.0.0 类型尚不认识 wait / end_session / reply.waitMs
 * （运行时对象与平台新契约一致，见 parser.ts 的本地扩展类型）；
 * 联合类型到成员的窄化 cast，contracts 发版后移除。
 */
function parseModelAction(
  text: string,
  options?: ParseCustomerSupportOptions,
): AgentAction {
  return parseCustomerSupportResponse(text, options) as AgentAction;
}

/**
 * Customer Support structured execution strategy.
 *
 * The system prompt assembles persona (here / decision-protocol.ts) from the
 * single-source decision protocol. Decision schema parsing lives in parser.ts.
 *
 * Export contract: the platform Agent Worker loads strategies from
 * STRATEGY_PLUGIN_PATH and expects the named exports `strategy` (static,
 * built-in prompt only) and/or `createStrategy` (factory), plus
 * `preResolveAiEmployeePrompt` and `getCachedAiEmployeeId`. Keep these four
 * stable — they are the plugin's real seam.
 *
 * AI Employee runtime connection (R2): the Worker provides a database via
 * `preResolveAiEmployeePrompt(db, ...)`. Resolution order:
 *   1. per-contact AI employee binding → published prompt
 *   2. workspace default AI employee → published prompt
 *   3. built-in customer support system prompt
 *
 * Keyword → employee routes (reception plan) were removed in R2. Contact
 * binding + workspace default are the only routing rules.
 *
 * The Solution's extension settings (extensionId support-pipeline) are read
 * through the same database handle with a short TTL cache: groupChat.
 * extraInstruction (group chat extra instruction) and pacing.
 * defaultReplyWaitMs (default wait for reply/ask; null disables). Any failure
 * fails open — the last known values stay in effect.
 */

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

/** Minimal database interface for raw SQL queries (host-injected handle). */
type RawDb = {
  execute: (
    query: unknown,
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
  sql: SqlTag;
};

const EXTENSION_SETTINGS = {
  solutionId: "weflow.customer-support",
  extensionId: "support-pipeline",
} as const;

/** 群聊附加指令 TTL（extension_settings 行内 groupChat 字段） */
const SETTINGS_CACHE_TTL_MS = 30_000;
/** AI 员工解析 TTL：prompt 与 employeeId 同 key 同生命周期 */
const RESOLUTION_CACHE_TTL_MS = 5 * 60 * 1000;

/** 从扩展设置容错提取群聊附加指令（groupChat.extraInstruction） */
function extractGroupInstruction(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const groupChat = (raw as Record<string, unknown>).groupChat;
  if (typeof groupChat !== "object" || groupChat === null) return null;
  const instruction = (groupChat as Record<string, unknown>).extraInstruction;
  return typeof instruction === "string" && instruction.trim() !== ""
    ? instruction.trim()
    : null;
}

/**
 * 从扩展设置容错提取「reply/ask 缺 wait_ms 时的默认等待」
 * （pacing.defaultReplyWaitMs）。返回 undefined = 未配置（保持业务默认
 * DEFAULT_REPLY_WAIT_MS，即默认开启）；null = 显式关闭（回到引擎语义：
 * 不带 wait_ms 表示本回合继续工作）；正数 = 自定义毫秒（parser 负责 clamp）。
 */
function extractDefaultReplyWaitMs(raw: unknown): number | null | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const pacing = (raw as Record<string, unknown>).pacing;
  if (typeof pacing !== "object" || pacing === null) return undefined;
  const value = (pacing as Record<string, unknown>).defaultReplyWaitMs;
  if (value === null || value === 0) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return value > 0 ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return undefined;
    return parsed > 0 ? parsed : null;
  }
  return undefined;
}

/** 群聊附加指令拼接：空指令原样返回（prompt 与未配置时逐字节一致） */
function appendGroupInstruction(
  system: string,
  instruction: string | null | undefined,
): string {
  return instruction && instruction.trim() !== ""
    ? `${system}\n\n【群聊附加指令】${instruction.trim()}`
    : system;
}

/** AI 员工运行时解析条目：prompt 与 employeeId 成对写入、同时过期。 */
type CachedEmployee = {
  prompt: string | null;
  employeeId: string | null;
  fetchedAt: number;
};

/**
 * 插件运行时工厂。Worker 走模块级单例；测试传 `now` 创建隔离实例
 * （假时钟驱动两个 TTL 缓存，互不串扰）。导出仅为测试接缝，
 * Worker 消费面始终是上面四个命名导出。
 */
export function createStrategyApi(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const employeeCache = new Map<string, CachedEmployee>();
  let settingsFetchedAt = 0;
  let groupInstruction: string | null = null;
  /** reply/ask 缺 wait_ms 时的默认等待；null = 关闭（沿用引擎语义）。 */
  let defaultReplyWaitMs: number | null = DEFAULT_REPLY_WAIT_MS;

  function cachedEmployee(key: string): CachedEmployee | undefined {
    const entry = employeeCache.get(key);
    if (!entry) return undefined;
    if (now() - entry.fetchedAt >= RESOLUTION_CACHE_TTL_MS) {
      employeeCache.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * 读取支撑管线扩展设置（TTL 缓存）：群聊附加指令 + 对话节奏开关。
   * 读失败 fail-open：保持上一次已生效值（首次即默认值），且不写缓存时间
   * 以便下次重试。
   */
  async function readPipelineSettings(db: RawDb): Promise<void> {
    if (
      settingsFetchedAt !== 0 &&
      now() - settingsFetchedAt < SETTINGS_CACHE_TTL_MS
    ) {
      return;
    }
    try {
      const result = await db.execute(
        db.sql`SELECT settings_json FROM solution.extension_settings
          WHERE scope = ${EXTENSION_SETTINGS.solutionId}
            AND key = ${EXTENSION_SETTINGS.extensionId}
          LIMIT 1`,
      );
      const settingsJson = result.rows?.[0]?.settings_json;
      groupInstruction = extractGroupInstruction(settingsJson);
      const extractedWaitMs = extractDefaultReplyWaitMs(settingsJson);
      if (extractedWaitMs !== undefined) defaultReplyWaitMs = extractedWaitMs;
      settingsFetchedAt = now();
    } catch {
      // fail-open：沿用当前值
    }
  }

  /** Fetch the latest published prompt for a given AI employee definition. */
  async function fetchPublishedPrompt(
    db: RawDb,
    definitionId: string,
  ): Promise<string | null> {
    const result = await db.execute(
      db.sql`SELECT prompt FROM customer_support.ai_employee_versions
        WHERE definition_id = ${definitionId} AND status = 'published'
        ORDER BY version DESC LIMIT 1`,
    );
    return (result.rows?.[0]?.prompt as string) ?? null;
  }

  /**
   * Resolve the AI employee (definition_id + published prompt) for a contact.
   * Priority: per-contact binding → workspace default. 一次解析成对返回，
   * 避免旧实现里 prompt/employeeId 两条路径重复跑同样的两条定位查询。
   * 任何失败 fail-open：返回 { null, null }，上层回退内置提示词。
   */
  async function resolveAiEmployee(
    db: RawDb,
    contactId: string,
  ): Promise<{ employeeId: string | null; prompt: string | null }> {
    try {
      // 1. Per-contact binding
      if (contactId) {
        const bindingResult = await db.execute(
          db.sql`SELECT cb.definition_id
            FROM customer_support.contact_agent_bindings cb
            JOIN customer_support.ai_employee_definitions ad ON ad.definition_id = cb.definition_id
            WHERE cb.contact_id = ${contactId} AND ad.status = 'active'
            LIMIT 1`,
        );
        const bindingId = bindingResult.rows?.[0]?.definition_id;
        if (typeof bindingId === "string") {
          return {
            employeeId: bindingId,
            prompt: await fetchPublishedPrompt(db, bindingId),
          };
        }
      }
      // 2. Workspace default
      const defaultResult = await db.execute(
        db.sql`SELECT default_definition_id FROM customer_support.ai_employee_workspace_default WHERE id = 1`,
      );
      const defaultId = defaultResult.rows?.[0]?.default_definition_id;
      if (typeof defaultId === "string") {
        return {
          employeeId: defaultId,
          prompt: await fetchPublishedPrompt(db, defaultId),
        };
      }
    } catch {
      // Database query failure should not block the strategy; fall through to built-in prompt.
    }
    return { employeeId: null, prompt: null };
  }

  function resolveBuiltinSystemPrompt(input: AgentStrategyContext): string {
    const knowledgeAvailable =
      input.availableTools.includes("retrieve_knowledge");
    const chatType = input.chatType ?? "private";
    return customerSupportSystemPrompt(knowledgeAvailable, chatType);
  }

  const strategy: AgentExecutionStrategy = {
    id: "weflow.customer-support/structured-v1",
    version: "1.3.0",
    buildModelRequest: (input) => {
      const knowledgeAvailable =
        input.availableTools.includes("retrieve_knowledge");
      const chatType = input.chatType ?? "private";
      // 群聊附加指令（扩展设置）：preResolve 时随员工解析一并预取
      const groupInstructionForRequest =
        chatType === "group" ? (groupInstruction ?? null) : null;

      // Cached AI employee resolution (populated by the async pre-resolver)
      const cached = cachedEmployee(
        `${input.contactId}:${input.conversationId}`,
      );
      if (cached?.prompt) {
        return {
          system: aiEmployeeSystemPrompt(
            cached.prompt,
            knowledgeAvailable,
            chatType,
            groupInstructionForRequest ?? undefined,
          ),
          messages: input.messages,
        };
      }

      return {
        system: appendGroupInstruction(
          resolveBuiltinSystemPrompt(input),
          groupInstructionForRequest,
        ),
        messages: input.messages,
      };
    },
    parseModelResponse: (input) =>
      parseModelAction(input.text, { defaultReplyWaitMs }),
    validateAction: () => ({ ok: true }),
  };

  /**
   * Pre-resolve AI employee prompt for a given contact/conversation pair.
   * Called by the agent-turn-executor before the strategy's buildModelRequest
   * to populate the cache.
   *
   * `triggerText` is the customer message that started this turn; it is
   * accepted for signature compatibility but no longer used (reception plan
   * keyword routing was removed in R2).
   */
  async function preResolveAiEmployeePrompt(
    db: RawDb,
    contactId: string,
    conversationId: string,
    _triggerText?: string | undefined,
  ): Promise<void> {
    const cacheKey = `${contactId}:${conversationId}`;
    if (cachedEmployee(cacheKey)) return;

    // 群聊附加指令随每次预解析刷新（TTL 缓存），供 buildModelRequest 同步使用。
    await readPipelineSettings(db);

    // prompt 与 definition_id 同优先级成对解析并写入同一条缓存：prompt 供
    // buildModelRequest 使用，definition_id 供 Turn 落库时写入
    // messages.actor_id（前端渲染头像）。未命中（含否定结果）也缓存，
    // 避免反复查库；prompt 为 null 时下次 buildModelRequest 回落内置提示词。
    const resolved = await resolveAiEmployee(db, contactId);
    employeeCache.set(cacheKey, {
      prompt: resolved.prompt,
      employeeId: resolved.employeeId,
      fetchedAt: now(),
    });
  }

  /** 读取缓存的 AI 员工 definition_id（preResolve 之后调用）；未命中 null */
  function getCachedAiEmployeeId(
    contactId: string,
    conversationId: string,
  ): string | null {
    return cachedEmployee(`${contactId}:${conversationId}`)?.employeeId ?? null;
  }

  return { strategy, preResolveAiEmployeePrompt, getCachedAiEmployeeId };
}

// 模块级单例：Worker 进程内共享缓存（每个 agent turn preResolve 一次）。
const api = createStrategyApi();

/**
 * Factory that creates the strategy with AI employee prompt cache support.
 * The Agent Worker should prefer this over the static `strategy` export.
 * The database query for AI employee prompts is done by the companion
 * `preResolveAiEmployeePrompt` export, which populates the cache before
 * `buildModelRequest` is called.
 */
export function createStrategy(_ctx?: {
  db?: unknown;
}): AgentExecutionStrategy {
  return api.strategy;
}

export const preResolveAiEmployeePrompt = api.preResolveAiEmployeePrompt;

export const getCachedAiEmployeeId = api.getCachedAiEmployeeId;

/**
 * Synchronous strategy (backward-compatible static export).
 * Uses the built-in prompt only; no database access for AI employee resolution.
 */
export const strategy: AgentExecutionStrategy = {
  id: "weflow.customer-support/structured-v1",
  version: "1.0.0",
  buildModelRequest: (input) => {
    const knowledgeAvailable =
      input.availableTools.includes("retrieve_knowledge");
    const chatType = input.chatType ?? "private";
    return {
      system: customerSupportSystemPrompt(knowledgeAvailable, chatType),
      messages: input.messages,
    };
  },
  parseModelResponse: (input) => parseModelAction(input.text),
  validateAction: () => ({ ok: true }),
};
