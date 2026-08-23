/**
 * 工具计划执行模块。
 *
 * Agent application owns the decision to execute a plan. ToolExecutionService
 * owns the persisted execution lifecycle; this module only adapts the current
 * tool dispatch to that boundary.
 */

import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { KnowledgeSearch } from "../../knowledge/contracts/knowledge-search.js";
import { readRuntimeSettings } from "../../operations/application/runtime-settings.js";
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

  throw new Error("tool_not_implemented");
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
