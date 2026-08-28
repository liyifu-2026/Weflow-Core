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

const PLAN_CACHE_TTL_MS = 30_000;
let planCache: ReceptionPlan | null = null;
let planCacheFetchedAt = 0;

async function readReceptionPlan(db: RawDb): Promise<ReceptionPlan> {
  if (planCache && Date.now() - planCacheFetchedAt < PLAN_CACHE_TTL_MS) {
    return planCache;
  }
  try {
    const result = await db.execute({
      sql:
        "SELECT settings_json FROM solution.extension_settings " +
        "WHERE solution_id = $1 AND extension_id = $2 LIMIT 1",
      args: [RECEPTION_SETTINGS.solutionId, RECEPTION_SETTINGS.extensionId],
    });
    const settingsJson = result.rows?.[0]?.settings_json;
    planCache = extractReceptionPlan(settingsJson);
    planCacheFetchedAt = Date.now();
    return planCache;
  } catch {
    // 读失败 fail-open：当作没有编排配置。
    return extractReceptionPlan(undefined);
  }
}

/** 触发文本 → 路由命中的员工 definition_id；无命中/未配置返回 null */
async function resolvePlanEmployeeId(
  db: RawDb,
  triggerText: string | undefined,
): Promise<string | null> {
  if (!triggerText || triggerText.trim() === "") return null;
  const plan = await readReceptionPlan(db);
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

/** 缓存命中员工对应的 definition_id（与 prompt 缓存同生命周期） */
const aiEmployeeIdCache = new Map<string, string>();

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

      // Check cached AI employee prompt (populated by the async pre-resolver)
      const cachedPrompt = aiEmployeePromptCache.get(
        `${input.contactId}:${input.conversationId}`,
      );
      if (cachedPrompt) {
        return {
          system: aiEmployeeSystemPrompt(
            cachedPrompt,
            knowledgeAvailable,
            chatType,
          ),
          messages: input.messages,
        };
      }

      return {
        system: resolveSystemPrompt(input),
        messages: input.messages,
      };
    },
    parseModelResponse: (input) => parseCustomerSupportResponse(input.text),
    validateAction: () => ({ ok: true }),
  };
}

/**
 * In-memory cache for AI employee prompts, keyed by contactId:conversationId.
 * Entries expire after 5 minutes to pick up prompt changes without restart.
 */
const aiEmployeePromptCache = new Map<string, string>();
const cacheTimestamps = new Map<string, number>();
const CACHE_TTL_MS = 5 * 60 * 1000;

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
  const cachedAt = cacheTimestamps.get(cacheKey);
  if (cachedAt && Date.now() - cachedAt < CACHE_TTL_MS) return;

  // 与 prompt 解析同一优先级顺序，把命中的员工 definition_id 一并缓存，
  // 供 Turn 落库时写入 messages.actor_id（前端据此渲染该员工的头像）。
  const employeeId = await resolveAiEmployeeId(db, contactId, triggerText);
  if (employeeId) {
    aiEmployeeIdCache.set(cacheKey, employeeId);
  } else {
    aiEmployeeIdCache.delete(cacheKey);
  }

  const prompt = await resolveAiEmployeePrompt(db, contactId, triggerText);
  if (prompt) {
    aiEmployeePromptCache.set(cacheKey, prompt);
    cacheTimestamps.set(cacheKey, Date.now());
  }
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
  return aiEmployeeIdCache.get(`${contactId}:${conversationId}`) ?? null;
}
