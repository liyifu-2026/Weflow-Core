/**
 * 知识控制面代理（application 层）。
 *
 * 浏览器只持有 Weflow Cookie；上游地址、Key 与认证头在此组装，
 * 不越过 Core Gateway。写操作的审计也在此落库。
 */
import { randomUUID } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { weknoraAuthHeaders } from "../../../infrastructure/knowledge/weknora-knowledge-client.js";
import type { KnowledgeProviderOptions } from "./boundary.js";

export type ProviderForwardResult =
  | { status: "ok"; upstream: Response }
  /** 上游 4xx/5xx：httpStatus 已按白名单收敛（其余归并为 502） */
  | { status: "rejected"; httpStatus: number }
  /** 网络/超时/请求体故障；message 供调用方识别 upload_too_large 等语义 */
  | { status: "failed"; message: string };

/** 构造上游请求并转发；网络/超时故障归并为 failed */
export async function forwardProviderRequest(input: {
  options: KnowledgeProviderOptions;
  method: string;
  path: string;
  query: string;
  contentType: string | undefined;
  accept: string | undefined;
  body: RequestInit["body"];
}): Promise<ProviderForwardResult> {
  const { options } = input;
  const upstreamUrl = new URL(`${options.baseUrl}/${input.path}`);
  upstreamUrl.search = input.query;
  const headers = new Headers();
  for (const [name, value] of Object.entries(weknoraAuthHeaders(options))) {
    headers.set(name, value);
  }
  headers.set("x-request-id", randomUUID());
  if (input.contentType) headers.set("content-type", input.contentType);
  if (input.accept) headers.set("accept", input.accept);

  try {
    const upstream = await (options.fetch ?? globalThis.fetch)(upstreamUrl, {
      method: input.method,
      headers,
      body: input.body,
      signal: AbortSignal.timeout(options.timeoutMs),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      const status = [400, 403, 404, 409, 413].includes(upstream.status)
        ? upstream.status
        : 502;
      return { status: "rejected", httpStatus: status };
    }
    return { status: "ok", upstream };
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "",
    };
  }
}

/** 写操作审计：记录操作者、路径与来源 IP */
export async function recordProviderMutation(
  db: NodePgDatabase<typeof schema>,
  input: {
    actorUserId: string;
    sourceIp: string;
    method: string;
    path: string;
  },
): Promise<void> {
  await db.insert(schema.auditEvents).values({
    auditId: randomUUID(),
    actorUserId: input.actorUserId,
    eventType: "knowledge.provider_mutated",
    subjectType: "knowledge_provider",
    subjectId: input.path.slice(0, 100),
    sourceIp: input.sourceIp,
    metadata: { method: input.method, path: input.path.slice(0, 500) },
  });
}
