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

/**
 * Customer Support structured execution strategy.
 *
 * The system prompt has been migrated from Core. Decision schema parsing
 * lives in parser.ts.
 *
 * Export contract: the platform Agent Worker loads strategies from
 * STRATEGY_PLUGIN_PATH and expects a named export `strategy`
 * (AgentExecutionStrategy). Keep this export name stable.
 *
 * AI Employee runtime connection (R2):
 * When the Worker provides a database via `createStrategy({ db })`, the
 * strategy resolves the AI employee's published prompt from the
 * `customer_support` schema at request time. Resolution order (R2):
 *   1. per-contact AI employee binding → published prompt
 *   2. workspace default AI employee → published prompt
 *   3. prompts.json static overrides
 *   4. built-in customer support system prompt
 *
 * Keyword → employee routes (reception plan) were removed in R2. Contact
 * binding + workspace default are the only routing rules.
 *
 * The group chat extra instruction lives in the Solution's extension
 * settings (extensionId support-pipeline) and is read through the same
 * database handle with a short TTL cache. Any failure fails open.
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

let lastGroupFetch = 0;
let cachedGroupInstruction: string | null = null;

/**
 * 读取群聊附加指令（TTL 缓存）。读失败 fail-open：返回 null 且不缓存失败结果。
 */
async function readGroupInstruction(db: RawDb): Promise<string | null> {
  if (
    lastGroupFetch !== 0 &&
    Date.now() - lastGroupFetch < SETTINGS_CACHE_TTL_MS
  ) {
    return cachedGroupInstruction;
  }
  try {
    const result = await db.execute({
      sql:
        "SELECT settings_json FROM solution.extension_settings " +
        "WHERE solution_id = $1 AND extension_id = $2 LIMIT 1",
      args: [
        EXTENSION_SETTINGS.solutionId,
        EXTENSION_SETTINGS.extensionId,
      ],
    });
    const settingsJson = result.rows?.[0]?.settings_json;
    cachedGroupInstruction = extractGroupInstruction(settingsJson);
    lastGroupFetch = Date.now();
    return cachedGroupInstruction;
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
 * Resolution order (R2): per-contact binding → workspace default → null.
 */
async function resolveAiEmployeePrompt(
  db: RawDb,
  contactId: string,
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
    // 2. Workspace default
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
 * prompt 与 employeeId 在一次预解析中成对写入、同时过期。
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
 * The Agent Worker should prefer this over the static `strategy` export.
 * The actual database query for AI employee prompts is done by the
 * companion `preResolveAiEmployeePrompt` export, which populates the
 * cache before `buildModelRequest` is called.
 *
 * Resolution order at request time (R2):
 *   1. AI employee prompt (per-contact binding → workspace default)
 *   2. prompts.json static overrides
 *   3. Built-in customer support system prompt
 */
export function createStrategy(_ctx?: { db?: unknown }): AgentExecutionStrategy {
  return {
    id: "weflow.customer-support/structured-v1",
    version: "1.2.0",
    buildModelRequest: (input) => {
      const knowledgeAvailable =
        input.availableTools.includes("retrieve_knowledge");
      const chatType = input.chatType ?? "private";
      // 群聊附加指令（扩展设置）：preResolve 时随员工解析一并预取
      const groupInstruction =
        chatType === "group" ? (cachedGroupInstruction ?? null) : null;

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
 * to populate the cache.
 *
 * `triggerText` is the customer message that started this turn; it is
 * accepted for signature compatibility but no longer used (reception plan
 * keyword routing was removed in R2).
 */
export async function preResolveAiEmployeePrompt(
  db: RawDb,
  contactId: string,
  conversationId: string,
  _triggerText?: string | undefined,
): Promise<void> {
  const cacheKey = `${contactId}:${conversationId}`;
  if (cachedEmployee(cacheKey)) return;

  // 群聊附加指令随每次预解析刷新（TTL 缓存），供 buildModelRequest 同步使用。
  await readGroupInstruction(db).catch(() => null);

  // prompt 与 definition_id 同优先级（联系人绑定 → 工作区默认）成对解析并
  // 写入同一条缓存：prompt 供 buildModelRequest 使用，definition_id 供 Turn
  // 落库时写入 messages.actor_id（前端渲染头像）。
  const employeeId = await resolveAiEmployeeId(db, contactId);
  const prompt = employeeId
    ? await fetchPublishedPrompt(db, employeeId)
    : await resolveAiEmployeePrompt(db, contactId);

  // 命中即缓存（含 employeeId 为 null 的否定结果，避免反复查库）；
  // prompt 为 null 时下次 buildModelRequest 回落静态/内置提示词。
  aiEmployeeCache.set(cacheKey, {
    prompt,
    employeeId,
    fetchedAt: Date.now(),
  });
}

/**
 * 解析本次消息命中的 AI 员工 definition_id（同 prompt 优先级：
 * 联系人绑定 → 工作区默认）；未命中返回 null。
 */
export async function resolveAiEmployeeId(
  db: RawDb,
  contactId: string,
): Promise<string | null> {
  try {
    if (contactId) {
      const bindingResult = await db.execute({
        sql: `
          SELECT cb.definition_id
          FROM customer_support.contact_agent_bindings cb
          JOIN customer_support.ai_employee_definitions ad ON ad.definition_id = cb.definition_id
          WHERE cb.contact_id = $1 AND ad.status = 'active'
          LIMIT 1
        `,
        args: [contactId],
      });
      const bindingRow = bindingResult.rows?.[0];
      if (typeof bindingRow?.definition_id === "string") {
        return bindingRow.definition_id;
      }
    }
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
  return cachedEmployee(`${contactId}:${conversationId}`)?.employeeId ?? null;
}