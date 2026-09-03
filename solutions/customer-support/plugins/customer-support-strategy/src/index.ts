import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentExecutionStrategy,
  AgentStrategyContext,
} from "@weflow-leaif/contracts";
import {
  customerSupportSystemPrompt,
  aiEmployeeSystemPrompt,
} from "./prompt.js";
import { parseCustomerSupportResponse } from "./parser.js";
import {
  extractReceptionPlan,
  matchEmployeeRoute,
  type ReceptionPlan,
} from "./reception-plan.js";

/**
 * Customer Support structured execution strategy.
 *
 * The system prompt has been migrated from Core. Decision schema parsing will
 * follow in the next extraction step.
 *
 * Export contract: the platform Agent Worker loads strategies from
 * STRATEGY_PLUGIN_PATH and expects a named export `strategy`
 * (AgentExecutionStrategy). Keep this export name stable so the same build
 * artifact can be inserted into any Weflow platform instance.
 *
 * AI Employee runtime connection:
 * When the Worker provides a database via `createStrategy({ db })`, the
 * strategy resolves the AI employee's published prompt from the
 * `customer_support` schema at request time. Resolution order:
 *   1. per-contact AI employee binding → published prompt
 *   2. reception plan keyword routes (trigger text → employeeKey)
 *   3. workspace default AI employee → published prompt
 *   4. prompts.json static overrides
 *   5. built-in customer support system prompt
 *
 * The reception plan (keyword → employee routes + default employee key)
 * lives in the Solution's extension settings (extensionId support-pipeline)
 * and is read through the same database handle with a short TTL cache.
 * Any failure in plan resolution fails open to the next priority.
 */

type PromptMap = {
  default?: string | null;
  contacts?: Record<string, string>;
  conversations?: Record<string, string>;
};

/** Minimal database interface for raw SQL queries (drizzle-compatible). */
type RawDb = {
  execute: (
    queryOrParams:
      | string
      | { sql: string; args: unknown[] },
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

const RECEPTION_SETTINGS = {
  solutionId: "weflow.customer-support",
  extensionId: "support-pipeline",
} as const;

/** 编排设置 TTL：plan 与群聊附加指令同源（同一 extension_settings 行） */
const SETTINGS_CACHE_TTL_MS = 30_000;
/** AI 员工解析 TTL：prompt 与 employeeId 同 key 同生命周期 */
const RESOLUTION_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 编排设置缓存（模块级单值）。
 * plan 与群聊附加指令读的是同一行 extension_settings，合并为一次读取
 * 与一条缓存，消除两套 TTL/空值标记的漂移空间。
 */
type CachedSettings = {
  plan: ReceptionPlan;
  groupInstruction: string | null;
  fetchedAt: number;
};
let settingsCache: CachedSettings | null = null;

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
 * 读取编排设置（TTL 缓存）。
 * 读失败 fail-open：返回"无编排配置"且不缓存失败结果，下次重读。
 */
async function readReceptionSettings(db: RawDb): Promise<CachedSettings> {
  if (
    settingsCache &&
    Date.now() - settingsCache.fetchedAt < SETTINGS_CACHE_TTL_MS
  ) {
    return settingsCache;
  }
  try {
    const result = await db.execute({
      sql:
        "SELECT settings_json FROM solution.extension_settings " +
        "WHERE solution_id = $1 AND extension_id = $2 LIMIT 1",
      args: [RECEPTION_SETTINGS.solutionId, RECEPTION_SETTINGS.extensionId],
    });
    const settingsJson = result.rows?.[0]?.settings_json;
    settingsCache = {
      plan: extractReceptionPlan(settingsJson),
      groupInstruction: extractGroupInstruction(settingsJson),
      fetchedAt: Date.now(),
    };
    return settingsCache;
  } catch {
    return {
      plan: extractReceptionPlan(undefined),
      groupInstruction: null,
      fetchedAt: 0,
    };
  }
}

/** 触发文本 → 路由命中的员工 definition_id；无命中/未配置返回 null */
async function resolvePlanEmployeeId(
  db: RawDb,
  triggerText: string | undefined,
): Promise<string | null> {
  if (!triggerText || triggerText.trim() === "") return null;
  const { plan } = await readReceptionSettings(db);
  const employeeKey = matchEmployeeRoute(triggerText, plan.employeeRoutes);
  if (!employeeKey) return null;
  try {
    const result = await db.execute({
      sql:
        "SELECT definition_id FROM customer_support.ai_employee_definitions " +
        "WHERE key = $1 AND status = 'active' LIMIT 1",
      args: [employeeKey],
    });
    const definitionId = result.rows?.[0]?.definition_id;
    return typeof definitionId === "string" ? definitionId : null;
  } catch {
    return null;
  }
}

function readPromptMap(): PromptMap {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const filePath = join(currentDir, "..", "prompts.json");
    return JSON.parse(readFileSync(filePath, "utf8")) as PromptMap;
  } catch {
    return {};
  }
}

/**
 * Resolve the AI employee's published prompt for a given contact.
 * Resolution order: per-contact binding → reception plan keyword routes →
 * workspace default → null.
 */
async function resolveAiEmployeePrompt(
  db: RawDb,
  contactId: string,
  triggerText?: string | undefined,
): Promise<string | null> {
  try {
    // 1. Per-contact binding
    if (contactId) {
      const bindingResult = await db.execute({
        sql:
          "SELECT cb.definition_id " +
          "FROM customer_support.contact_agent_bindings cb " +
          "JOIN customer_support.ai_employee_definitions ad ON ad.definition_id = cb.definition_id " +
          "WHERE cb.contact_id = $1 AND ad.status = 'active' " +
          "LIMIT 1",
        args: [contactId],
      });
      const bindingRow = bindingResult.rows?.[0];
      if (bindingRow?.definition_id) {
        const prompt = await fetchPublishedPrompt(
          db,
          bindingRow.definition_id as string,
        );
        if (prompt) return prompt;
      }
    }
    // 2. Reception plan keyword routes (trigger text → employee)
    const planEmployeeId = await resolvePlanEmployeeId(db, triggerText);
    if (planEmployeeId) {
      const prompt = await fetchPublishedPrompt(db, planEmployeeId);
      if (prompt) return prompt;
    }
    // 3. Workspace default
    const defaultResult = await db.execute(
      "SELECT default_definition_id FROM customer_support.ai_employee_workspace_default WHERE id = 1",
    );
    const defaultRow = defaultResult.rows?.[0];
    if (defaultRow?.default_definition_id) {
      const prompt = await fetchPublishedPrompt(
        db,
        defaultRow.default_definition_id as string,
      );
      if (prompt) return prompt;
    }
  } catch {
    // Database query failure should not block the strategy; fall through to static prompts.
  }
  return null;
}

/** Fetch the latest published prompt for a given AI employee definition. */
async function fetchPublishedPrompt(
  db: RawDb,
  definitionId: string,
): Promise<string | null> {
  const result = await db.execute({
    sql:
      "SELECT prompt FROM customer_support.ai_employee_versions " +
      "WHERE definition_id = $1 AND status = 'published' " +
      "ORDER BY version DESC LIMIT 1",
    args: [definitionId],
  });
  return (result.rows?.[0]?.prompt as string) ?? null;
}

/**
 * AI 员工运行时解析缓存，keyed by `${contactId}:${conversationId}`。
 * prompt 与 employeeId 在一次预解析中成对写入、同时过期，
 * 不会出现"prompt 来自员工 A 而 actor_id 来自员工 B"的窗口。
 */
type CachedEmployee = {
  prompt: string | null;
  employeeId: string | null;
  fetchedAt: number;
};
const aiEmployeeCache = new Map<string, CachedEmployee>();

function cachedEmployee(key: string): CachedEmployee | undefined {
  const entry = aiEmployeeCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt >= RESOLUTION_CACHE_TTL_MS) {
    aiEmployeeCache.delete(key);
    return undefined;
  }
  return entry;
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

function resolveSystemPrompt(
  input: AgentStrategyContext,
): string {
  const promptMap = readPromptMap();
  const knowledgeAvailable = input.availableTools.includes("retrieve_knowledge");
  const chatType = input.chatType ?? "private";

  // Static prompts.json overrides (per-contact / per-conversation / default)
  const staticPrompt =
    (input.contactId ? promptMap.contacts?.[input.contactId] : undefined) ??
    promptMap.conversations?.[input.conversationId] ??
    promptMap.default ??
    null;
  if (staticPrompt) return staticPrompt;

  // Fall back to the built-in customer support system prompt.
  // When db is available, AI employee prompt resolution happens asynchronously
  // via the wrapper in createStrategy; this synchronous path is the fallback.
  return customerSupportSystemPrompt(knowledgeAvailable, chatType);
}

/**
 * Synchronous strategy (backward-compatible static export).
 * Uses prompts.json + built-in prompt; no database access for AI employee resolution.
 */
export const strategy: AgentExecutionStrategy = {
  id: "weflow.customer-support/structured-v1",
  version: "1.0.0",
  buildModelRequest: (input) => ({
    system: resolveSystemPrompt(input),
    messages: input.messages,
  }),
  parseModelResponse: (input) => parseCustomerSupportResponse(input.text),
  validateAction: () => ({ ok: true }),
};

/**
 * Factory that creates a strategy with AI employee prompt cache support.
 * The Agent Worker should prefer this over the static `strategy`
 * export. The actual database query for AI employee prompts is done by
 * the companion `preResolveAiEmployeePrompt` export, which populates
 * the cache before `buildModelRequest` is called.
 *
 * Resolution order at request time:
 *   1. AI employee prompt (per-contact binding → workspace default)
 *   2. prompts.json static overrides
 *   3. Built-in customer support system prompt
 */
export function createStrategy(_ctx?: { db?: unknown }): AgentExecutionStrategy {

  return {
    id: "weflow.customer-support/structured-v1",
    version: "1.2.0",
    buildModelRequest: (input) => {
      // Synchronous path: use static prompt resolution.
      // AI employee prompt is resolved asynchronously via the cached map.
      const knowledgeAvailable =
        input.availableTools.includes("retrieve_knowledge");
      const chatType = input.chatType ?? "private";
      // 群聊附加指令（接待编排配置）：preResolve 时随编排设置一并预取
      const groupInstruction =
        chatType === "group" ? (settingsCache?.groupInstruction ?? null) : null;

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
            groupInstruction ?? undefined,
          ),
          messages: input.messages,
        };
      }

      return {
        system: appendGroupInstruction(
          resolveSystemPrompt(input),
          groupInstruction,
        ),
        messages: input.messages,
      };
    },
    parseModelResponse: (input) => parseCustomerSupportResponse(input.text),
    validateAction: () => ({ ok: true }),
  };
}

/**
 * Pre-resolve AI employee prompt for a given contact/conversation pair.
 * Called by the agent-turn-executor before the strategy's buildModelRequest
 * to populate the cache. This is the async entry point that enables
 * database-backed prompt resolution.
 *
 * `triggerText` is the customer message that started this turn; it drives
 * the reception plan's keyword → employee routes. When omitted (older
 * callers), routing degrades to binding + workspace default only.
 */
export async function preResolveAiEmployeePrompt(
  db: RawDb,
  contactId: string,
  conversationId: string,
  triggerText?: string | undefined,
): Promise<void> {
  const cacheKey = `${contactId}:${conversationId}`;
  if (cachedEmployee(cacheKey)) return;

  // 编排设置（含群聊附加指令）随每次预解析刷新（TTL 缓存），
  // 供 buildModelRequest 同步使用；与员工解析同一 DB 句柄。
  await readReceptionSettings(db).catch(() => ({
    plan: extractReceptionPlan(undefined),
    groupInstruction: null,
    fetchedAt: 0,
  }));

  // prompt 与 definition_id 同优先级（联系人绑定 → 关键词路由 → 工作区
  // 默认）成对解析并写入同一条缓存：prompt 供 buildModelRequest 使用，
  // definition_id 供 Turn 落库时写入 messages.actor_id（前端渲染头像）。
  const employeeId = await resolveAiEmployeeId(db, contactId, triggerText);
  const prompt = employeeId
    ? await fetchPublishedPrompt(db, employeeId)
    : await resolveAiEmployeePrompt(db, contactId, triggerText);

  // 命中即缓存（含 employeeId 为 null 的否定结果，避免反复查库）；
  // prompt 为 null 时下次 buildModelRequest 回落静态/内置提示词。
  aiEmployeeCache.set(cacheKey, {
    prompt,
    employeeId,
    fetchedAt: Date.now(),
  });
}

/**
 * 解析本次 Turn 命中的 AI 员工 definition_id（与 prompt 同优先级：
 * 联系人绑定 → 关键词路由 → 工作区默认）；未命中返回 null。
 */
export async function resolveAiEmployeeId(
  db: RawDb,
  contactId: string,
  triggerText?: string | undefined,
): Promise<string | null> {
  try {
    if (contactId) {
      const bindingResult = await db.execute({
        sql:
          "SELECT cb.definition_id " +
          "FROM customer_support.contact_agent_bindings cb " +
          "JOIN customer_support.ai_employee_definitions ad ON ad.definition_id = cb.definition_id " +
          "WHERE cb.contact_id = $1 AND ad.status = 'active' " +
          "LIMIT 1",
        args: [contactId],
      });
      const bindingRow = bindingResult.rows?.[0];
      if (typeof bindingRow?.definition_id === "string") {
        return bindingRow.definition_id;
      }
    }
    const planEmployeeId = await resolvePlanEmployeeId(db, triggerText);
    if (planEmployeeId) return planEmployeeId;
    const defaultResult = await db.execute(
      "SELECT default_definition_id FROM customer_support.ai_employee_workspace_default WHERE id = 1",
    );
    const defaultRow = defaultResult.rows?.[0];
    if (typeof defaultRow?.default_definition_id === "string") {
      return defaultRow.default_definition_id;
    }
  } catch {
    // 解析失败不影响主链路；返回 null 由上层回退通用标识。
  }
  return null;
}

/** 读取缓存的 AI 员工 definition_id（preResolve 之后调用）；未命中 null */
export function getCachedAiEmployeeId(
  contactId: string,
  conversationId: string,
): string | null {
  return (
    cachedEmployee(`${contactId}:${conversationId}`)?.employeeId ?? null
  );
}
