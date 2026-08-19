import { Readable, Transform } from "node:stream";
import { randomUUID } from "node:crypto";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import * as databaseSchema from "../../../infrastructure/postgres/schema.js";
import {
  requireAdminIdentity,
  requireBusinessIdentity,
} from "../../identity/interface/request-authentication.js";
import {
  inspectKnowledgeEngine,
  isAllowedKnowledgeProviderMethod,
  isAllowedKnowledgeProviderPath,
  knowledgeProviderAccess,
  MAX_KNOWLEDGE_UPLOAD_BYTES,
  providerPath,
  type KnowledgeProviderOptions,
} from "../application/boundary.js";

export {
  inspectKnowledgeEngine,
  isAllowedKnowledgeProviderMethod,
  isAllowedKnowledgeProviderPath,
  knowledgeProviderAccess,
  MAX_KNOWLEDGE_UPLOAD_BYTES,
  providerPath,
} from "../application/boundary.js";

const PREFIX = "/api/v1/console/knowledge-provider/";
/**
 * Console 的知识控制面代理。浏览器只持有 Weflow Cookie；上游地址、Key、
 * Cookie 与内部错误不会越过 Core Gateway。
 */
export function registerKnowledgeProviderRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
  options: KnowledgeProviderOptions | undefined,
): void {
  server.get("/api/v1/admin/knowledge-engine", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    return reply.send(await inspectKnowledgeEngine(options));
  });

  server.addContentTypeParser(
    /^multipart\/form-data(?:;.*)?$/,
    (_request, payload, done) => {
      let bytes = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > MAX_KNOWLEDGE_UPLOAD_BYTES
              ? new Error("upload_too_large")
              : null,
            bytes > MAX_KNOWLEDGE_UPLOAD_BYTES ? undefined : chunk,
          );
        },
      });
      done(null, payload.pipe(limiter));
    },
  );

  server.all(
    `${PREFIX}*`,
    { bodyLimit: MAX_KNOWLEDGE_UPLOAD_BYTES },
    async (request, reply) => {
      const path = providerPath(request);
      if (!path || !isAllowedKnowledgeProviderPath(path)) {
        return reply.code(404).send({ error: "knowledge_route_not_allowed" });
      }
      if (!isAllowedKnowledgeProviderMethod(path, request.method))
        return reply.code(405).send({ error: "knowledge_method_not_allowed" });

      const access = knowledgeProviderAccess(path, request.method);
      const identity =
        access === "read"
          ? await requireBusinessIdentity(db, request, reply)
          : await requireAdminIdentity(db, request, reply);
      if (!identity) return;
      if (!options)
        return reply
          .code(503)
          .send({ error: "knowledge_provider_unavailable" });

      const upstreamUrl = new URL(`${options.baseUrl}/${path}`);
      const sourceUrl = new URL(request.raw.url ?? "", "http://weflow.local");
      upstreamUrl.search = sourceUrl.search;
      const headers = new Headers();
      headers.set("x-api-key", options.apiKey);
      headers.set("x-request-id", randomUUID());
      const contentType = request.headers["content-type"];
      if (contentType) headers.set("content-type", contentType);
      const accept = request.headers.accept;
      if (accept) headers.set("accept", accept);

      try {
        const upstream = await (options.fetch ?? globalThis.fetch)(
          upstreamUrl,
          {
            method: request.method,
            headers,
            body: requestBody(request),
            signal: AbortSignal.timeout(options.timeoutMs),
            duplex: "half",
          } as RequestInit & { duplex: "half" },
        );

        if (!upstream.ok) {
          await upstream.body?.cancel();
          const status = [400, 403, 404, 409, 413].includes(upstream.status)
            ? upstream.status
            : 502;
          return await reply
            .code(status)
            .send({ error: "knowledge_provider_rejected" });
        }

        reply.code(upstream.status);
        for (const name of [
          "content-type",
          "content-disposition",
          "cache-control",
          "content-length",
        ]) {
          const value = upstream.headers.get(name);
          if (value) reply.header(name, value);
        }
        if (access === "write") {
          await db.insert(databaseSchema.auditEvents).values({
            auditId: randomUUID(),
            actorUserId: identity.user.userId,
            eventType: "knowledge.provider_mutated",
            subjectType: "knowledge_provider",
            subjectId: path.slice(0, 100),
            sourceIp: request.ip,
            metadata: { method: request.method, path: path.slice(0, 500) },
          });
        }
        if (!upstream.body) return await reply.send();
        return await reply.send(
          Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("upload_too_large"))
          return await reply.code(413).send({ error: "upload_too_large" });
        return await reply
          .code(502)
          .send({ error: "knowledge_provider_failed" });
      }
    },
  );
}

function requestBody(request: FastifyRequest): RequestInit["body"] {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const body = request.body;
  if (body === undefined || body === null) return undefined;
  if (body instanceof Readable) return body;
  if (typeof body === "string" || body instanceof Uint8Array) return body;
  return JSON.stringify(body);
}
