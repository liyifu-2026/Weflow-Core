/**
 * 工具计划执行模块。
 *
 * Agent application owns the decision to execute a plan. ToolExecutionService
 * owns the persisted execution lifecycle; this module only adapts the current
 * tool dispatch to that boundary.
 */

import { and, desc, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { promises as dnsPromises } from "node:dns";
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
    throw new Error("history_query_failed", { cause: error });
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
  const speakerLabel = speaker;
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
  const totalMatched = totalRows[0]?.value ?? 0;

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
    ...new Set(
      rows.map((row) => row.actorId).filter((id): id is string => Boolean(id)),
    ),
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
/** 重定向逐跳复检的最大跳数（每跳都重新做公网校验，防 302 打内网）。 */
const MAX_REDIRECT_HOPS = 5;

async function fetchUrlText(rawUrl: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, FETCH_URL_TIMEOUT_MS);
  try {
    // redirect:"manual"：每一跳都重新走 assertPublicHttpUrl（含 DNS 解析
    // 后的 IP 公网性判定）。redirect:"follow" 只校验首跳，公网 URL 一个
    // 302 就能把内网地址的响应体带回来。
    let url = await assertPublicHttpUrl(rawUrl);
    for (let hop = 0; ; hop += 1) {
      const response = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "WeflowAgent/1.0",
          accept: "text/html,text/plain,application/json,application/xhtml+xml",
        },
      });
      if (
        [301, 302, 303, 307, 308].includes(response.status) &&
        response.headers.get("location")
      ) {
        if (hop >= MAX_REDIRECT_HOPS) {
          throw new Error("too_many_redirects");
        }
        const next = await assertPublicHttpUrl(
          new URL(response.headers.get("location") as string, url).toString(),
        );
        url = next;
        continue;
      }
      if (!response.ok) {
        throw new Error(`http_${String(response.status)}`);
      }
      return await readUrlText(url, response);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function readUrlText(
  url: URL,
  response: Response,
): Promise<Record<string, unknown>> {
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
}

/**
 * 校验 URL 为公网 http(s)。除字面量黑名单外，还把主机名解析成 IP 逐个
 * 判定公网性——域名 A 记录指到内网地址（单次解析即可，无需 DNS 重绑定）
 * 与 IPv6 内网段都靠这一步拦住。
 */
async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("unsupported_url_protocol");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isBlockedHostnameLiteral(hostname)) {
    throw new Error("url_host_blocked");
  }
  for (const address of await resolveHostAddresses(hostname)) {
    if (!isPublicIp(address)) {
      throw new Error("url_host_blocked");
    }
  }
  return url;
}

/** 字面量快速拦截（含 IPv6 本体与 *.localhost）。 */
function isBlockedHostnameLiteral(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    return true;
  }
  if (netIsIPv4(hostname)) {
    return !isPublicIPv4(hostname);
  }
  if (hostname.includes(":")) {
    return !isPublicIPv6(hostname);
  }
  return false;
}

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  if (netIsIPv4(hostname) || hostname.includes(":")) {
    return [hostname];
  }
  try {
    const records = await dnsPromises.lookup(hostname, { all: true });
    return records.map((record) => record.address);
  } catch {
    throw new Error("url_host_unresolvable");
  }
}

function netIsIPv4(value: string): boolean {
  return netIsIP(value) === 4;
}

function netIsIP(value: string): 4 | 6 | 0 {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return 4;
  if (/^[0-9a-f:]+$/i.test(value) && value.includes(":")) return 6;
  return 0;
}

function isPublicIp(address: string): boolean {
  if (netIsIPv4(address)) return isPublicIPv4(address);
  return isPublicIPv6(address);
}

/** 导出仅供单元测试断言分类逻辑。 */
export function isPublicIPv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false; // 本机/私网
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // 私网
  if (a === 192 && b === 168) return false; // 私网
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return false; // 基准测试段
  if (a === 192 && b === 0 && parts[2] === 0) return false; // 192.0.0.0/24
  if (a === 192 && b === 0 && parts[2] === 2) return false; // TEST-NET
  if (a === 198 && b === 51 && parts[2] === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // 组播/保留
  return true;
}

/** 导出仅供单元测试断言分类逻辑。 */
export function isPublicIPv6(ip: string): boolean {
  // 先展开成 8 组 16bit（处理 :: 缩写与内嵌 IPv4），再按前缀 + 内嵌
  // IPv4 判定：::ffff:x/96 映射、2002::/16 6to4、64:ff9b::/96 NAT64 的
  // 内嵌 v4 若为私网，内核连接时仍会落到内网地址——只看前缀拦不住。
  const groups = expandIPv6Groups(ip);
  if (!groups) return false; // 解析失败 = 不放行
  // IPv4-mapped ::ffff:0:0/96（点分与 hex 形式统一在此判定）
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return isPublicIPv4(`${(groups[6]! >> 8) & 0xff}.${groups[6]! & 0xff}.${(groups[7]! >> 8) & 0xff}.${groups[7]! & 0xff}`);
  }
  // 6to4 2002::/16：内嵌公网 IPv4 = 第 2、3 组
  if (groups[0] === 0x2002) {
    return isPublicIPv4(
      `${(groups[1]! >> 8) & 0xff}.${groups[1]! & 0xff}.${(groups[2]! >> 8) & 0xff}.${groups[2]! & 0xff}`,
    );
  }
  // Teredo 2001:0::/32：客户端 v4 被混淆且本身就是隧道语义，一律不放行
  if (groups[0] === 0x2001 && groups[1] === 0) return false;
  // NAT64 64:ff9b::/96：内嵌 IPv4 = 最后两组
  if (groups[0] === 0x64 && groups[1] === 0xff9b) {
    return isPublicIPv4(
      `${(groups[6]! >> 8) & 0xff}.${groups[6]! & 0xff}.${(groups[7]! >> 8) & 0xff}.${groups[7]! & 0xff}`,
    );
  }
  const first = groups[0]!;
  if (first === 0 || (first & 0xfe00) === 0xfc00) return false; // 未指定/本机/ULA
  if ((first & 0xffc0) === 0xfe80) return false; // link-local
  if ((first & 0xff00) === 0xff00) return false; // 组播
  if (first === 0x2001 && groups[1] === 0x0db8) return false; // 文档段
  return true;
}

/** 把 IPv6 字面量展开为 8 组 16bit 整数；支持 :: 缩写与末尾点分 IPv4。 */
function expandIPv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  // 末尾内嵌点分 IPv4（如 ::ffff:127.0.0.1）转成两组 hex
  const embedded = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded) {
    const parts = embedded[2]!.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => n > 255)) return null;
    text = `${embedded[1]}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const doubleColon = text.split("::");
  if (doubleColon.length > 2) return null;
  const head = doubleColon[0] ? doubleColon[0].split(":") : [];
  const tail = doubleColon.length === 2 && doubleColon[1] ? doubleColon[1].split(":") : [];
  if (head.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  if (tail.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (doubleColon.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...tail].map(
    (g) => Number.parseInt(g, 16),
  );
  return groups.length === 8 ? groups : null;
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
