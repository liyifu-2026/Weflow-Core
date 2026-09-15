/**
 * 工具计划执行模块。
 *
 * Agent application owns the decision to execute a plan. ToolExecutionService
 * owns the persisted execution lifecycle; this module only adapts the current
 * tool dispatch to that boundary.
 */

import { and, desc, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { KnowledgeSearch } from "../../knowledge/contracts/knowledge-search.js";
import { readRuntimeSettings } from "../../operations/application/runtime-settings.js";
import { maskedSenderLabel } from "../../conversations/application/sender-display.js";
import {
  ToolExecutionService,
  type ToolExecutionRecord,
} from "./tool-execution-service.js";

/** 工具执行结果 */
export type ToolExecutionResult = {
  status: "succeeded" | "failed" | "already_completed" | "not_claimable";
  result?: Record<string, unknown>;
  errorCode?: string;
};

/** Minimal executor seam; a formal ToolRegistry is intentionally out of scope. */
export type ToolExecutor = (
  execution: ToolExecutionRecord,
) => Promise<Record<string, unknown>>;

export type ExecuteToolPlanDependencies = {
  knowledgeSearch?: KnowledgeSearch | undefined;
  executor?: ToolExecutor | undefined;
};

/** Executes one persisted plan. Repeating the same execution is idempotent. */
export async function executeToolPlan(
  db: NodePgDatabase<typeof schema>,
  executionId: string,
  dependencies: ExecuteToolPlanDependencies = {},
): Promise<ToolExecutionResult> {
  const service = new ToolExecutionService(db);
  const claim = await service.claim(executionId);
  if (claim.status === "already_completed") {
    return { status: "already_completed", result: claim.result };
  }
  if (claim.status === "not_claimable") {
    return { status: "not_claimable", errorCode: claim.errorCode };
  }

  try {
    const result = dependencies.executor
      ? await dependencies.executor(claim.execution)
      : await executeCurrentTool(
          db,
          claim.execution,
          dependencies.knowledgeSearch,
        );
    return await service.complete(
      executionId,
      result,
      claim.execution.claimedAt,
    );
  } catch (error) {
    const errorCode =
      error instanceof Error ? error.message.slice(0, 200) : "tool_failed";
    return await service.fail(
      executionId,
      errorCode,
      claim.execution.claimedAt,
    );
  }
}

/** Current dispatch only; tool definitions/registry remain a later slice. */
async function executeCurrentTool(
  db: NodePgDatabase<typeof schema>,
  execution: ToolExecutionRecord,
  knowledgeSearch: KnowledgeSearch | undefined,
): Promise<Record<string, unknown>> {
  if (execution.toolName === "query_contact_profile") {
    const profiles = await db
      .select({
        contactId: schema.contactProfiles.contactId,
        channel: schema.contactProfiles.channel,
        note: schema.contactProfiles.note,
        tags: schema.contactProfiles.tags,
      })
      .from(schema.contactProfiles)
      .innerJoin(
        schema.conversations,
        eq(schema.conversations.contactId, schema.contactProfiles.contactId),
      )
      .where(eq(schema.conversations.conversationId, execution.conversationId))
      .limit(1);
    return { profile: profiles[0] ?? null };
  }

  if (execution.toolName === "retrieve_knowledge") {
    const query = execution.arguments.query;
    if (typeof query !== "string" || !query.trim()) {
      throw new Error("invalid_knowledge_query");
    }
    // Existing behavior: disabled retrieval is a successful empty snapshot.
    const runtime = await readRuntimeSettings(db);
    if (!runtime.knowledgeEnabled) {
      return {
        query,
        evidence: [],
        retrievedAt: new Date().toISOString(),
        disabled: true,
      };
    }
    if (!knowledgeSearch) throw new Error("weknora_not_configured");
    return {
      query,
      evidence: await knowledgeSearch.search({ query }),
      retrievedAt: new Date().toISOString(),
    };
  }

  if (execution.toolName === "fetch_url") {
    const url = execution.arguments.url;
    if (typeof url !== "string" || !url.trim()) {
      throw new Error("invalid_fetch_url");
    }
    return await fetchUrlText(url);
  }

  if (execution.toolName === "search_chat_history") {
    return await searchChatHistory(db, execution);
  }

  throw new Error("tool_not_implemented");
}

/**
 * 群历史消息检索（仅群聊下发）：查本会话入站文本消息，按说话者/关键词/
 * 时间窗过滤。speaker 支持昵称（经联系人资料解析）或 wxid 直配；
 * 返回 messages + total_matched + truncated，喂回模型作"可信事实"。
 */
const HISTORY_MAX_TEXT_LENGTH = 200;

async function searchChatHistory(
  db: NodePgDatabase<typeof schema>,
  execution: ToolExecutionRecord,
): Promise<Record<string, unknown>> {
  try {
    return await searchChatHistoryInner(db, execution);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("invalid_history")) {
      throw error;
    }
    throw new Error("history_query_failed");
  }
}

async function searchChatHistoryInner(
  db: NodePgDatabase<typeof schema>,
  execution: ToolExecutionRecord,
): Promise<Record<string, unknown>> {
  const args = execution.arguments;
  const scope = args.scope;
  if (scope !== "speaker" && scope !== "group") {
    throw new Error("invalid_history_scope");
  }
  const speaker = typeof args.speaker === "string" ? args.speaker.trim() : "";
  if (scope === "speaker" && !speaker) {
    throw new Error("invalid_history_scope");
  }
  const keyword = typeof args.keyword === "string" ? args.keyword.trim() : "";
  const beforeHours = Number(args.before_hours ?? 72);
  if (!Number.isFinite(beforeHours) || beforeHours < 1 || beforeHours > 720) {
    throw new Error("invalid_history_scope");
  }
  const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 20);
  const since = new Date(Date.now() - beforeHours * 3_600_000);

  // speaker 解析：先按 wxid 直配；查无此人再按昵称/备注在联系人资料里找
  let actorId: string | null = null;
  let speakerLabel = speaker;
  if (scope === "speaker") {
    const byWxid = await db
      .select({ resolved: schema.contactProfiles.channelContactId })
      .from(schema.contactProfiles)
      .where(eq(schema.contactProfiles.channelContactId, speaker))
      .limit(1);
    if (byWxid.length === 0) {
      const byName = await db
        .select({ resolved: schema.contactProfiles.channelContactId })
        .from(schema.contactProfiles)
        .where(
          or(
            ilike(schema.contactProfiles.channelNickname, `%${speaker}%`),
            ilike(schema.contactProfiles.channelDisplayName, `%${speaker}%`),
            ilike(schema.contactProfiles.channelRemark, `%${speaker}%`),
            ilike(schema.contactProfiles.sharedAlias, `%${speaker}%`),
          ),
        )
        .limit(1);
      actorId = byName[0]?.resolved ?? null;
    } else {
      actorId = speaker;
    }
  }

  const conditions = [
    eq(schema.messages.conversationId, execution.conversationId),
    eq(schema.messages.direction, "inbound"),
    eq(schema.messages.contentType, "text"),
    gt(schema.messages.occurredAt, since),
  ];
  if (actorId) conditions.push(eq(schema.messages.actorId, actorId));
  if (keyword) {
    conditions.push(ilike(schema.messages.text, `%${keyword}%`));
  }

  const totalRows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(schema.messages)
    .where(and(...conditions));
  const totalMatched = Number(totalRows[0]?.value ?? 0);

  const rows = await db
    .select({
      actorId: schema.messages.actorId,
      text: schema.messages.text,
      occurredAt: schema.messages.occurredAt,
    })
    .from(schema.messages)
    .where(and(...conditions))
    .orderBy(desc(schema.messages.occurredAt))
    .limit(limit + 1);
  const truncated = rows.length > limit;

  // 发送者昵称解析（成员/联系人资料），回给模型可读名字
  const actorIds = [
    ...new Set(rows.map((row) => row.actorId).filter((id): id is string => Boolean(id))),
  ];
  const nameMap = new Map<string, string>();
  if (actorIds.length > 0) {
    const nameRows = await db
      .select({
        channelContactId: schema.contactProfiles.channelContactId,
        channelDisplayName: schema.contactProfiles.channelDisplayName,
        channelNickname: schema.contactProfiles.channelNickname,
        channelRemark: schema.contactProfiles.channelRemark,
        sharedAlias: schema.contactProfiles.sharedAlias,
      })
      .from(schema.contactProfiles)
      .where(inArray(schema.contactProfiles.channelContactId, actorIds));
    for (const row of nameRows) {
      const resolved =
        row.sharedAlias?.trim() ||
        row.channelDisplayName?.trim() ||
        row.channelRemark?.trim() ||
        row.channelNickname?.trim() ||
        "";
      if (resolved) nameMap.set(row.channelContactId, resolved);
    }
  }

  return {
    scope,
    ...(scope === "speaker" ? { speaker: speakerLabel } : {}),
    ...(keyword ? { keyword } : {}),
    messages: rows.slice(0, limit).map((row) => ({
      speaker: row.actorId
        ? (nameMap.get(row.actorId) ?? maskedSenderLabel(row.actorId))
        : "未知",
      at: row.occurredAt.toISOString(),
      text: row.text.slice(0, HISTORY_MAX_TEXT_LENGTH),
    })),
    total_matched: totalMatched,
    truncated,
  };
}

const MAX_URL_CONTENT_BYTES = 256 * 1024;
const MAX_URL_TEXT_LENGTH = 8_000;
const FETCH_URL_TIMEOUT_MS = 15_000;

async function fetchUrlText(rawUrl: string): Promise<Record<string, unknown>> {
  const url = assertPublicHttpUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, FETCH_URL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "WeflowAgent/1.0",
        accept: "text/html,text/plain,application/json,application/xhtml+xml",
      },
    });
    if (!response.ok) {
      throw new Error(`http_${String(response.status)}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("text/plain") &&
      !contentType.includes("application/json") &&
      !contentType.includes("application/xhtml+xml")
    ) {
      return {
        url: url.toString(),
        fetchedAt: new Date().toISOString(),
        contentType,
        text: "",
        note: "unsupported_content_type",
      };
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("empty_response_body");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const result = (await reader.read()) as {
        done: boolean;
        value?: Uint8Array;
      };
      if (result.done) break;
      const value = result.value;
      if (value === undefined) break;
      chunks.push(value);
      total += value.byteLength;
      if (total > MAX_URL_CONTENT_BYTES) {
        await reader.cancel();
        break;
      }
    }
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
    const cleaned = stripHtml(text).slice(0, MAX_URL_TEXT_LENGTH);
    return {
      url: url.toString(),
      fetchedAt: new Date().toISOString(),
      contentType,
      text: cleaned,
      truncated: text.length > MAX_URL_TEXT_LENGTH,
    };
  } finally {
    clearTimeout(timer);
  }
}

function assertPublicHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("unsupported_url_protocol");
  }
  if (isBlockedHostname(url.hostname.toLowerCase())) {
    throw new Error("url_host_blocked");
  }
  return url;
}

function isBlockedHostname(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".local")
  ) {
    return true;
  }
  if (hostname.startsWith("127.")) return true;
  if (hostname.startsWith("10.")) return true;
  if (hostname.startsWith("192.168.")) return true;
  if (hostname.startsWith("169.254.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  return false;
}

function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}
