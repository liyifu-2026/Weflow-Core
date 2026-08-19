/**
 * 知识模块 HTTP 路由
 *
 * 注册客户端知识检索和草稿生成的 REST API 端点。
 * 所有路由均需要业务身份认证。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { OpenAiCompatibleClient } from "../../../infrastructure/model_runtime/openai-compatible-client.js";
import type { WeKnoraKnowledgeClient } from "../../../infrastructure/knowledge/weknora-knowledge-client.js";
import {
  requireAdminIdentity,
  requireBusinessIdentity,
} from "../../identity/interface/request-authentication.js";
import {
  applyKnowledgeContextOverride,
  chatKnowledgeWorkspace,
  appendKnowledgeThreadMessage,
  buildKnowledgeActionOutput,
  generateKnowledgeAnswerFromEvidence,
  generateReplyDraft,
  generateClientKnowledgeDraft,
  getKnowledgeConversationContext,
  getKnowledgeDocumentContent,
  getConversationKnowledgeEvidence,
  getKnowledgeEvidenceTray,
  getKnowledgeImageFile,
  getKnowledgeLibrary,
  getKnowledgeThreadMessages,
  getKnowledgeWikiPageContent,
  getOrCreateKnowledgeThread,
  listKnowledgeScopes,
  listKnowledgeThreads,
  recentConversationContext,
  resolveKnowledgeBaseIds,
  retrieveClientKnowledge,
  recordKnowledgeFeedback,
  searchKnowledgeWorkspace,
  updateKnowledgeEvidenceTray,
  updateKnowledgeThreadMessageSuggestions,
} from "../application/client-knowledge-service.js";
import type { KnowledgeContextOverride } from "../application/client-knowledge-service.js";
import type { KnowledgeConversationContext } from "../application/client-knowledge-service.js";
import { normalizeSuggestionText } from "../application/suggestion-sanitizer.js";

const paramsSchema = z.object({ conversationId: z.string().min(1).max(300) });
const retrieveBody = z
  .object({ query: z.string().trim().min(1).max(2_000) })
  .strict();
const draftBody = z
  .object({ retrievalId: z.string().min(1).max(100) })
  .strict();
const workspaceSearchBody = z
  .object({
    query: z.string().trim().min(1).max(2_000),
    knowledgeBaseIds: z.array(z.string().min(1).max(300)).max(20).optional(),
    knowledgeIds: z.array(z.string().min(1).max(300)).max(50).optional(),
    tagIds: z.array(z.string().min(1).max(300)).max(50).optional(),
    mentionedItems: z
      .array(z.record(z.string(), z.string().max(300)))
      .max(20)
      .optional(),
    conversationId: z.string().min(1).max(300).optional(),
    depth: z.enum(["quick", "deep"]).default("quick"),
  })
  .strict();
const workspaceChatBody = z
  .object({
    query: z.string().trim().min(1).max(2_000),
    history: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string().trim().min(1).max(4_000),
        }),
      )
      .max(12)
      .default([]),
    knowledgeBaseIds: z.array(z.string().min(1).max(300)).max(20).optional(),
    knowledgeIds: z.array(z.string().min(1).max(300)).max(50).optional(),
    tagIds: z.array(z.string().min(1).max(300)).max(50).optional(),
    mentionedItems: z
      .array(z.record(z.string(), z.string().max(300)))
      .max(20)
      .optional(),
    conversationId: z.string().min(1).max(300).optional(),
    depth: z.enum(["quick", "deep"]).default("quick"),
  })
  .strict();
const documentParams = z.object({ documentId: z.string().min(1).max(300) });
const wikiPageQuery = z.object({
  knowledgeBaseId: z.string().min(1).max(300),
  slug: z.string().min(1).max(500),
});
const imageQuery = z.object({
  file: z
    .string()
    .min(1)
    .max(200)
    .regex(/^resource:\/\/[A-Za-z0-9_-]{22}$/),
  kb: z.string().min(1).max(300),
});
const streamBody = z
  .object({
    query: z.string().trim().min(1).max(2_000),
    threadId: z.string().min(1).max(100).optional(),
    conversationId: z.string().min(1).max(300).optional(),
    contextOverride: z
      .object({
        confirmedFacts: z.array(z.string().max(300)).max(20).optional(),
        missingInformation: z.array(z.string().max(300)).max(20).optional(),
        triedSteps: z.array(z.string().max(300)).max(20).optional(),
        product: z.string().max(100).nullable().optional(),
        errorCode: z.string().max(100).nullable().optional(),
      })
      .optional(),
    includeRecentMessages: z.boolean().optional(),
    selectedEvidenceIds: z.array(z.string().min(1).max(300)).max(20).optional(),
    outputMode: z
      .enum(["answer", "reply", "troubleshooting"])
      .default("answer"),
    knowledgeBaseIds: z.array(z.string().min(1).max(300)).max(20).optional(),
    knowledgeIds: z.array(z.string().min(1).max(300)).max(50).optional(),
    tagIds: z.array(z.string().min(1).max(300)).max(50).optional(),
    mentionedItems: z
      .array(z.record(z.string(), z.string().max(300)))
      .max(20)
      .optional(),
    depth: z.enum(["quick", "deep"]).default("quick"),
  })
  .strict();
const trayBody = z
  .object({
    evidence: z
      .array(
        z
          .object({
            chunkId: z.string().min(1).max(300),
            knowledgeId: z.string().min(1).max(300),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
const feedbackBody = z
  .object({
    conversationId: z.string().min(1).max(300).optional(),
    threadId: z.string().min(1).max(100).optional(),
    query: z.string().max(2_000),
    answer: z.string().max(20_000),
    referenceIds: z.array(z.string().max(300)).max(50).default([]),
    feedbackType: z.enum(["helpful", "not_helpful", "inserted", "copied"]),
    reason: z.string().max(1_000).optional(),
  })
  .strict();
const stopBody = z.object({ streamId: z.uuid() }).strict();

type ActiveKnowledgeStream = {
  userId: string;
  threadId: string;
  sessionId: string;
  messageId?: string;
  answer: string;
  references: Record<string, unknown>[];
  controller: AbortController;
  stopped: boolean;
  stopRequested: boolean;
  status: "running" | "stopped" | "superseded" | "completed" | "failed";
  stopUpstream: () => Promise<void>;
};

type ReplySuggestion = {
  suggestionId: string;
  text: string;
  sourceRevision: number;
  generatedAt: string;
  evidenceIds: string[];
  generationStatus: "complete";
};

type KnowledgeRouteDependencies = {
  weknora?: WeKnoraKnowledgeClient | undefined;
  model?: OpenAiCompatibleClient | undefined;
};

/** 注册知识模块的所有 HTTP 路由 */
export function registerKnowledgeRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
  dependencies: KnowledgeRouteDependencies,
): void {
  const activeStreams = new Map<string, ActiveKnowledgeStream>();
  const generationLocks = new Set<string>();
  const selectedAnswerLocks = new Set<string>();

  // 检索配置：显式白名单契约（dense / BM25 / rerank 阈值）。
  // 不开放 tenants/kv 通配；未知客户端字段被 strict schema 拒绝；
  // 上游未知字段由 client 的 read-modify-write 保留。
  const retrievalSettingsSchema = z
    .object({
      embedding_top_k: z.number().int().min(0).max(100).optional(),
      vector_threshold: z.number().min(0).max(1).optional(),
      keyword_threshold: z.number().min(0).max(1).optional(),
      rerank_top_k: z.number().int().min(0).max(100).optional(),
      rerank_threshold: z.number().min(0).max(1).optional(),
      rerank_model_id: z.string().max(200).optional(),
    })
    .strict();

  server.get("/api/v1/admin/retrieval-settings", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    if (!dependencies.weknora)
      return reply.code(503).send({ error: "knowledge_provider_unavailable" });
    return reply.send({
      settings: await dependencies.weknora.getRetrievalSettings(),
    });
  });

  server.put("/api/v1/admin/retrieval-settings", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    if (!dependencies.weknora)
      return reply.code(503).send({ error: "knowledge_provider_unavailable" });
    const body = retrievalSettingsSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_request" });
    const patch: Record<string, number | string> = {};
    if (body.data.embedding_top_k !== undefined)
      patch.embeddingTopK = body.data.embedding_top_k;
    if (body.data.vector_threshold !== undefined)
      patch.vectorThreshold = body.data.vector_threshold;
    if (body.data.keyword_threshold !== undefined)
      patch.keywordThreshold = body.data.keyword_threshold;
    if (body.data.rerank_top_k !== undefined)
      patch.rerankTopK = body.data.rerank_top_k;
    if (body.data.rerank_threshold !== undefined)
      patch.rerankThreshold = body.data.rerank_threshold;
    if (body.data.rerank_model_id !== undefined)
      patch.rerankModelId = body.data.rerank_model_id;
    const settings = await dependencies.weknora.updateRetrievalSettings(patch);
    return reply.send({ settings });
  });

  // ---------- 受控治理：模型 / 向量库 / 存储 ----------
  // 替代无 schema 校验的通配代理：字段白名单 + 错误白名单化。
  const governanceError = (
    reply: FastifyReply,
    error: unknown,
    fallback: string,
  ) => {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("weknora_request_failed:404"))
      return reply.code(404).send({ error: "governance_not_found" });
    if (message.includes("weknora_request_failed:400"))
      return reply.code(400).send({ error: "governance_invalid" });
    if (message.includes("weknora_request_failed:409"))
      return reply.code(409).send({ error: "governance_conflict" });
    return reply.code(502).send({ error: fallback });
  };

  server.post("/api/v1/admin/knowledge-models", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    const body = z
      .object({
        name: z.string().trim().min(1).max(120),
        type: z.string().trim().min(1).max(60),
        source: z.string().trim().min(1).max(40),
        display_name: z.string().trim().max(200).optional(),
        description: z.string().trim().max(1_000).optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_request" });
    if (!dependencies.weknora)
      return reply.code(503).send({ error: "knowledge_provider_unavailable" });
    try {
      const created = await dependencies.weknora.createModel(body.data);
      return await reply.code(201).send({ model: created });
    } catch (error) {
      return governanceError(reply, error, "model_create_failed");
    }
  });

  server.delete(
    "/api/v1/admin/knowledge-models/:modelId",
    async (request, reply) => {
      if (!(await requireAdminIdentity(db, request, reply))) return;
      const params = z
        .object({ modelId: z.string().min(1).max(200) })
        .safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      if (!dependencies.weknora)
        return reply
          .code(503)
          .send({ error: "knowledge_provider_unavailable" });
      try {
        await dependencies.weknora.deleteModel(params.data.modelId);
        return await reply.send({ deleted: true });
      } catch (error) {
        return governanceError(reply, error, "model_delete_failed");
      }
    },
  );

  server.post(
    "/api/v1/admin/knowledge-vector-stores",
    async (request, reply) => {
      if (!(await requireAdminIdentity(db, request, reply))) return;
      const body = z
        .object({
          name: z.string().trim().min(1).max(120),
          engine_type: z.string().trim().min(1).max(60),
          connection_config: z.record(z.string(), z.unknown()).optional(),
        })
        .strict()
        .safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_request" });
      if (!dependencies.weknora)
        return reply
          .code(503)
          .send({ error: "knowledge_provider_unavailable" });
      try {
        const created = await dependencies.weknora.createVectorStore(body.data);
        return await reply.code(201).send({ vectorStore: created });
      } catch (error) {
        return governanceError(reply, error, "vector_store_create_failed");
      }
    },
  );

  server.post(
    "/api/v1/admin/knowledge-vector-stores/test",
    async (request, reply) => {
      if (!(await requireAdminIdentity(db, request, reply))) return;
      const body = z
        .object({
          name: z.string().trim().min(1).max(120),
          engine_type: z.string().trim().min(1).max(60),
          connection_config: z.record(z.string(), z.unknown()).optional(),
        })
        .strict()
        .safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_request" });
      if (!dependencies.weknora)
        return reply
          .code(503)
          .send({ error: "knowledge_provider_unavailable" });
      try {
        const result = await dependencies.weknora.testVectorStore(body.data);
        return await reply.send({ result });
      } catch (error) {
        return governanceError(reply, error, "vector_store_test_failed");
      }
    },
  );

  server.post(
    "/api/v1/admin/knowledge-storage-backends",
    async (request, reply) => {
      if (!(await requireAdminIdentity(db, request, reply))) return;
      const body = z
        .object({
          name: z.string().trim().min(1).max(120),
          provider: z.string().trim().min(1).max(60),
        })
        .strict()
        .safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_request" });
      if (!dependencies.weknora)
        return reply
          .code(503)
          .send({ error: "knowledge_provider_unavailable" });
      try {
        const created = await dependencies.weknora.createStorageBackend(
          body.data,
        );
        return await reply.code(201).send({ storageBackend: created });
      } catch (error) {
        return governanceError(reply, error, "storage_backend_create_failed");
      }
    },
  );

  // 建议回复：为会话生成一条可采用的回复（复用知识问答管线，收集版不写 HTTP SSE）。
  server.post(
    "/api/v1/conversations/:conversationId/suggestion",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = z
        .object({ conversationId: z.string().min(1).max(300) })
        .safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const weknora = dependencies.weknora;
      if (!weknora)
        return reply.code(503).send({ error: "knowledge_unavailable" });

      const context = await getKnowledgeConversationContext(
        db,
        params.data.conversationId,
      );
      if (!context)
        return reply.code(404).send({ error: "conversation_not_found" });

      const [latest] = await db
        .select({ text: schema.messages.text })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.conversationId, params.data.conversationId),
            eq(schema.messages.direction, "inbound"),
          ),
        )
        .orderBy(desc(schema.messages.occurredAt))
        .limit(1);
      const query = latest?.text.trim();
      if (!query)
        return await reply.code(409).send({ error: "no_customer_question" });

      const controller = new AbortController();
      try {
        const thread = await getOrCreateKnowledgeThread(db, weknora, {
          userId: identity.user.userId,
          title: query,
          conversationId: params.data.conversationId,
          scopeType: "conversation",
          sourceIp: request.ip,
        });
        // 默认检索租户全部知识库：建议回复必须带知识依据（显式空列表 = 不检索）
        const knowledgeBaseIds = await resolveKnowledgeBaseIds(weknora);
        const upstream = await weknora.streamKnowledgeQA(
          thread.weknoraSessionId,
          query,
          { knowledgeBaseIds },
          controller.signal,
        );
        const suggestion = await collectKnowledgeSuggestion(
          upstream,
          context.revision,
        );
        if (!suggestion)
          return await reply
            .code(503)
            .send({ error: "suggestion_unavailable" });
        return await reply.send({ suggestion });
      } catch {
        return await reply.code(503).send({ error: "suggestion_unavailable" });
      } finally {
        controller.abort();
      }
    },
  );

  server.get("/api/v1/knowledge/threads", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const query = z
      .object({
        scopeType: z.enum(["standalone", "conversation"]).optional(),
        scopeId: z.string().min(1).max(300).optional(),
      })
      .safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ error: "invalid_request" });
    if (query.data.scopeType === "conversation" && !query.data.scopeId) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    return reply.send({
      threads: await listKnowledgeThreads(db, identity.user.userId, {
        ...(query.data.scopeType ? { scopeType: query.data.scopeType } : {}),
        ...(query.data.scopeId ? { scopeId: query.data.scopeId } : {}),
      }),
    });
  });
  server.get(
    "/api/v1/conversations/:conversationId/knowledge/context",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = paramsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const context = await getKnowledgeConversationContext(
        db,
        params.data.conversationId,
      );
      return context
        ? reply.send({ context })
        : reply.code(404).send({ error: "conversation_not_found" });
    },
  );
  server.get(
    "/api/v1/conversations/:conversationId/knowledge/evidence-tray",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = paramsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      return reply.send({
        conversationId: params.data.conversationId,
        evidence: await getConversationKnowledgeEvidence(
          db,
          identity.user.userId,
          params.data.conversationId,
        ),
      });
    },
  );
  server.put(
    "/api/v1/conversations/:conversationId/knowledge/evidence-tray",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = paramsSchema.safeParse(request.params);
      const body = trayBody.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      if (!dependencies.weknora)
        return reply.code(503).send({ error: "knowledge_unavailable" });
      try {
        return await reply.send({
          conversationId: params.data.conversationId,
          evidence: await updateKnowledgeEvidenceTray(db, {
            userId: identity.user.userId,
            conversationId: params.data.conversationId,
            evidence: body.data.evidence,
            weknora: dependencies.weknora,
            sourceIp: request.ip,
          }),
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "knowledge_evidence_not_found"
        )
          return reply.code(404).send({ error: "evidence_not_found" });
        return reply.code(503).send({ error: "knowledge_unavailable" });
      }
    },
  );
  server.post("/api/v1/knowledge/feedback", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const body = feedbackBody.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_request" });
    await recordKnowledgeFeedback(db, {
      userId: identity.user.userId,
      ...body.data,
      sourceIp: request.ip,
    });
    return reply.code(202).send({ recorded: true });
  });
  server.get(
    "/api/v1/knowledge/threads/:threadId/messages",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = z
        .object({ threadId: z.string().min(1).max(100) })
        .safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const messages = await getKnowledgeThreadMessages(
        db,
        identity.user.userId,
        params.data.threadId,
      );
      if (!messages) return reply.code(404).send({ error: "thread_not_found" });
      return reply.send({ threadId: params.data.threadId, messages });
    },
  );
  server.post(
    "/api/v1/conversations/:conversationId/knowledge/retrieve",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = paramsSchema.safeParse(request.params);
      const body = retrieveBody.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      return sendResult(
        reply,
        await retrieveClientKnowledge(db, dependencies.weknora, {
          conversationId: params.data.conversationId,
          userId: identity.user.userId,
          query: body.data.query,
          sourceIp: request.ip,
        }),
      );
    },
  );
  server.post(
    "/api/v1/conversations/:conversationId/knowledge/draft",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = paramsSchema.safeParse(request.params);
      const body = draftBody.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      return sendResult(
        reply,
        await generateClientKnowledgeDraft(db, dependencies.model, {
          conversationId: params.data.conversationId,
          userId: identity.user.userId,
          retrievalId: body.data.retrievalId,
          sourceIp: request.ip,
        }),
      );
    },
  );
  server.post("/api/v1/knowledge/search", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const body = workspaceSearchBody.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_request" });
    return sendWorkspaceResult(
      reply,
      await searchKnowledgeWorkspace(db, dependencies.weknora, {
        userId: identity.user.userId,
        query: body.data.query,
        sourceIp: request.ip,
        knowledgeBaseIds: body.data.knowledgeBaseIds,
        knowledgeIds: body.data.knowledgeIds,
        tagIds: body.data.tagIds,
        mentionedItems: body.data.mentionedItems,
        conversationId: body.data.conversationId,
        depth: body.data.depth,
      }),
    );
  });
  server.get("/api/v1/knowledge/scopes", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const result = await listKnowledgeScopes(dependencies.weknora);
    if (result.status === "ok") return reply.code(200).send(result);
    return reply.code(503).send({ error: result.status });
  });
  server.get("/api/v1/knowledge/library", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const query = z
      .object({ knowledgeBaseId: z.string().min(1).max(300).optional() })
      .safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ error: "invalid_request" });
    const result = await getKnowledgeLibrary(
      dependencies.weknora,
      query.data.knowledgeBaseId
        ? { knowledgeBaseId: query.data.knowledgeBaseId }
        : undefined,
    );
    if (result.status === "ok") return reply.code(200).send(result);
    return reply.code(503).send({ error: result.status });
  });
  server.post("/api/v1/knowledge/answer/stream", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const body = streamBody.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_request" });
    const weknora = dependencies.weknora;
    if (!weknora)
      return reply.code(503).send({ error: "knowledge_unavailable" });
    if (body.data.selectedEvidenceIds?.length) {
      return streamSelectedKnowledgeAnswer(
        reply,
        db,
        dependencies,
        selectedAnswerLocks,
        {
          userId: identity.user.userId,
          query: body.data.query,
          threadId: body.data.threadId,
          conversationId: body.data.conversationId,
          selectedEvidenceIds: body.data.selectedEvidenceIds,
          contextOverride: body.data.contextOverride,
          includeRecentMessages: body.data.includeRecentMessages,
          outputMode: body.data.outputMode,
          sourceIp: request.ip,
        },
      );
    }

    // Fast Path（§29）：reply 模式且当前会话已有结构化 Brief（已确认事实足够）时，
    // 跳过 WeKnora 检索，直接用本地模型生成短回复；模型不可用时走原路径。
    if (body.data.outputMode === "reply" && body.data.conversationId) {
      const fastContext = await getKnowledgeConversationContext(
        db,
        body.data.conversationId,
      );
      if (fastContext?.hasStructuredBriefing) {
        if (!dependencies.model) {
          return reply.code(503).send({ error: "model_unavailable" });
        }
        return streamFastPathSuggestion(reply, db, dependencies, {
          userId: identity.user.userId,
          query: body.data.query,
          conversationId: body.data.conversationId,
          context: fastContext,
          sourceIp: request.ip,
        });
      }
    }

    let sessionId: string;
    let threadId: string;
    let upstream: Response;
    let generationLockKey: string | undefined;
    const controller = new AbortController();
    try {
      const thread = await getOrCreateKnowledgeThread(db, weknora, {
        userId: identity.user.userId,
        threadId: body.data.threadId,
        title: body.data.query,
        conversationId: body.data.conversationId,
        scopeType: body.data.conversationId ? "conversation" : "standalone",
        sourceIp: request.ip,
      });
      threadId = thread.threadId;
      generationLockKey = `${identity.user.userId}\0${threadId}`;
      if (generationLocks.has(generationLockKey)) {
        return await reply.code(409).send({ error: "generation_in_progress" });
      }
      generationLocks.add(generationLockKey);
      sessionId = thread.weknoraSessionId;
      // 未显式指定时默认检索租户全部知识库：建议回复必须带知识依据
      const knowledgeBaseIds = await resolveKnowledgeBaseIds(
        weknora,
        body.data.knowledgeBaseIds,
      );
      await appendKnowledgeThreadMessage(db, {
        userId: identity.user.userId,
        threadId,
        role: "user",
        content: body.data.query,
        metadata: queryOptionsMetadata({
          knowledgeBaseIds,
          selectedEvidenceIds: body.data.selectedEvidenceIds,
          contextOverride: body.data.contextOverride,
          includeRecentMessages: body.data.includeRecentMessages,
          depth: body.data.depth,
        }),
      });
      upstream = await weknora.streamKnowledgeQA(
        sessionId,
        body.data.query,
        {
          knowledgeBaseIds,
          knowledgeIds: body.data.knowledgeIds,
          tagIds: body.data.tagIds,
          mentionedItems: body.data.mentionedItems,
        },
        controller.signal,
      );
    } catch (error) {
      if (generationLockKey) generationLocks.delete(generationLockKey);
      if (
        error instanceof Error &&
        error.message === "knowledge_thread_not_found"
      ) {
        return reply.code(404).send({ error: "thread_not_found" });
      }
      return reply.code(503).send({ error: "generation_failed" });
    }

    const streamId = randomUUID();
    const active: ActiveKnowledgeStream = {
      userId: identity.user.userId,
      threadId,
      sessionId,
      answer: "",
      references: [],
      controller,
      stopped: false,
      stopRequested: false,
      status: "running",
      stopUpstream: () => {
        if (!active.messageId) return Promise.resolve();
        return weknora.stopSession(sessionId, active.messageId);
      },
    };
    for (const [previousStreamId, previous] of activeStreams) {
      if (
        previous.userId === active.userId &&
        previous.threadId === active.threadId &&
        !previous.controller.signal.aborted
      ) {
        previous.status = "superseded";
        previous.stopped = true;
        previous.controller.abort();
        activeStreams.delete(previousStreamId);
      }
    }
    activeStreams.set(streamId, active);
    request.raw.once("close", () => {
      if (activeStreams.has(streamId)) {
        controller.abort();
        activeStreams.delete(streamId);
        active.status = "failed";
        if (generationLockKey) generationLocks.delete(generationLockKey);
      }
    });

    reply.hijack();
    reply.raw.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    writeSse(reply, { type: "started", streamId, threadId });
    let complete = false;
    let queryContext:
      Awaited<ReturnType<typeof getKnowledgeConversationContext>> | undefined;
    let actionOutput:
      Awaited<ReturnType<typeof buildKnowledgeActionOutput>> | undefined;
    let replySuggestion: ReplySuggestion | undefined;
    try {
      complete = await forwardKnowledgeSse(reply, upstream, active);
      if (
        complete &&
        !active.stopped &&
        active.status === "running" &&
        active.answer
      ) {
        const conversationId = body.data.conversationId;
        const serverContext = conversationId
          ? await getKnowledgeConversationContext(db, conversationId)
          : undefined;
        const override = body.data.contextOverride;
        queryContext =
          serverContext && (override || body.data.includeRecentMessages)
            ? applyKnowledgeContextOverride(
                serverContext,
                override,
                body.data.includeRecentMessages && conversationId
                  ? await recentConversationContext(db, conversationId)
                  : undefined,
              )
            : serverContext;
        actionOutput = await buildKnowledgeActionOutput(dependencies.model, {
          answer: active.answer,
          references: body.data.selectedEvidenceIds?.length
            ? active.references.filter((item) =>
                body.data.selectedEvidenceIds?.includes(
                  String(item.evidenceId),
                ),
              )
            : active.references,
          context: queryContext,
        });
        writeSse(reply, { type: "action_output", output: actionOutput });
        if (body.data.outputMode === "reply" && queryContext) {
          replySuggestion = buildReplySuggestion(
            actionOutput.reply || active.answer,
            queryContext.revision,
            active.references,
          );
          writeSse(reply, {
            type: "reply_suggestion",
            suggestion: replySuggestion,
          });
        }
      }
      if (active.answer) {
        const assistantMessageId = await appendKnowledgeThreadMessage(db, {
          userId: active.userId,
          threadId: active.threadId,
          role: "assistant",
          content: active.answer,
          references: active.references,
          metadata: assistantMetadata({
            actionOutput: actionOutput,
            conversationRevision: queryContext?.revision ?? null,
            replySuggestion,
          }),
          completed: complete && !active.stopped && active.status === "running",
        });
        if (
          complete &&
          !active.stopped &&
          active.status === "running" &&
          active.messageId
        ) {
          try {
            const suggestionSet = await weknora.ensureSuggestions(
              active.sessionId,
              active.messageId,
            );
            const suggestions = suggestionSet?.questions ?? [];
            if (suggestionSet && suggestions.length > 0) {
              await updateKnowledgeThreadMessageSuggestions(
                db,
                active.userId,
                assistantMessageId,
                [
                  {
                    suggestionSetId: suggestionSet.id,
                    questions: suggestions,
                  },
                ],
              );
              writeSse(reply, {
                type: "suggestions",
                suggestions,
                suggestionSetId: suggestionSet.id,
              });
            }
          } catch {
            // 推荐问题是增强能力，不能让已完成的回答变成失败。
          }
        }
      }
    } catch {
      if (!active.controller.signal.aborted) {
        writeSse(reply, { type: "error", code: "generation_failed" });
      }
      if (active.status === "running") active.status = "failed";
    }
    if (active.status === "running") {
      active.status = completeStatus(active, complete);
    }
    activeStreams.delete(streamId);
    if (generationLockKey) generationLocks.delete(generationLockKey);
    if (active.status === "completed") writeSse(reply, { type: "complete" });
    if (active.status === "stopped") writeSse(reply, { type: "stopped" });
    if (active.status === "superseded") writeSse(reply, { type: "superseded" });
    if (active.status === "failed") writeSse(reply, { type: "failed" });
    if (!controller.signal.aborted) reply.raw.end();
  });
  server.post("/api/v1/knowledge/answer/stop", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const body = stopBody.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_request" });
    const active = activeStreams.get(body.data.streamId);
    if (!active) return reply.code(404).send({ error: "stream_not_found" });
    if (active.userId !== identity.user.userId)
      return reply.code(404).send({ error: "stream_not_found" });
    active.stopped = true;
    active.status = "stopped";
    active.stopRequested = !active.messageId;
    if (!active.messageId)
      return reply.code(202).send({ stopped: true, pending: true });
    try {
      await active.stopUpstream();
    } catch {
      return reply.code(503).send({ error: "stop_failed" });
    }
    return reply.code(202).send({ stopped: true });
  });
  server.post("/api/v1/knowledge/chat", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const body = workspaceChatBody.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_request" });
    const result = await chatKnowledgeWorkspace(
      db,
      dependencies.weknora,
      dependencies.model,
      {
        userId: identity.user.userId,
        query: body.data.query,
        history: body.data.history,
        sourceIp: request.ip,
        knowledgeBaseIds: body.data.knowledgeBaseIds,
        knowledgeIds: body.data.knowledgeIds,
        tagIds: body.data.tagIds,
        mentionedItems: body.data.mentionedItems,
        conversationId: body.data.conversationId,
      },
    );
    if (result.status === "ok") return reply.code(200).send(result.result);
    return reply
      .code(result.status === "model_unavailable" ? 503 : 503)
      .send({ error: result.status });
  });
  server.get(
    "/api/v1/knowledge/documents/:documentId",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = documentParams.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      if (!dependencies.weknora)
        return reply.code(503).send({ error: "knowledge_unavailable" });
      try {
        return {
          document: await dependencies.weknora.getDocument(
            params.data.documentId,
          ),
        };
      } catch {
        return reply.code(503).send({ error: "knowledge_unavailable" });
      }
    },
  );
  server.get(
    "/api/v1/knowledge/documents/:documentId/preview",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = documentParams.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      if (!dependencies.weknora)
        return reply.code(503).send({ error: "knowledge_unavailable" });
      try {
        const preview = await dependencies.weknora.preview(
          params.data.documentId,
        );
        return await reply
          .type(preview.contentType)
          .header("content-disposition", "inline")
          .send(Buffer.from(preview.body));
      } catch {
        return reply.code(503).send({ error: "knowledge_unavailable" });
      }
    },
  );
  server.get(
    "/api/v1/knowledge/documents/:documentId/content",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = documentParams.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const result = await getKnowledgeDocumentContent(
        dependencies.weknora,
        params.data.documentId,
      );
      if (result.status === "ok")
        return reply.code(200).send({
          documentId: params.data.documentId,
          ...result.content,
        });
      return reply.code(503).send({ error: result.status });
    },
  );
  server.get("/api/v1/knowledge/wiki-pages/content", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const query = wikiPageQuery.safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ error: "invalid_request" });
    const result = await getKnowledgeWikiPageContent(
      dependencies.weknora,
      query.data.knowledgeBaseId,
      query.data.slug,
    );
    if (result.status === "ok")
      return reply.code(200).send({
        pageId: `${query.data.knowledgeBaseId}/${query.data.slug}`,
        ...result.content,
      });
    return reply.code(503).send({ error: result.status });
  });
  server.get("/api/v1/knowledge/images", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const query = imageQuery.safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ error: "invalid_request" });
    const result = await getKnowledgeImageFile(
      dependencies.weknora,
      query.data.kb,
      query.data.file,
    );
    if (result.status === "ok") {
      return await reply
        .type(result.contentType)
        .header("cache-control", "private, max-age=86400")
        .send(Buffer.from(result.body));
    }
    return reply
      .code(result.status === "not_found" ? 404 : 503)
      .send({ error: result.status });
  });
}

function completeStatus(
  active: ActiveKnowledgeStream,
  complete: boolean,
): ActiveKnowledgeStream["status"] {
  if (active.status !== "running") return active.status;
  return complete ? "completed" : active.stopped ? "stopped" : "failed";
}

async function streamSelectedKnowledgeAnswer(
  reply: FastifyReply,
  db: NodePgDatabase<typeof schema>,
  dependencies: KnowledgeRouteDependencies,
  locks: Set<string>,
  input: {
    userId: string;
    query: string;
    threadId?: string | undefined;
    conversationId?: string | undefined;
    selectedEvidenceIds: string[];
    contextOverride?: KnowledgeContextOverride | undefined;
    includeRecentMessages?: boolean | undefined;
    outputMode: "answer" | "reply" | "troubleshooting";
    sourceIp: string;
  },
): Promise<void> {
  const lockKey = `${input.userId}\0${input.conversationId ?? "standalone"}`;
  if (locks.has(lockKey)) {
    return void reply.code(409).send({ error: "generation_in_progress" });
  }
  locks.add(lockKey);
  try {
    await streamSelectedKnowledgeAnswerLocked(reply, db, dependencies, input);
  } finally {
    locks.delete(lockKey);
  }
}

async function streamSelectedKnowledgeAnswerLocked(
  reply: FastifyReply,
  db: NodePgDatabase<typeof schema>,
  dependencies: KnowledgeRouteDependencies,
  input: {
    userId: string;
    query: string;
    threadId?: string | undefined;
    conversationId?: string | undefined;
    selectedEvidenceIds: string[];
    contextOverride?: KnowledgeContextOverride | undefined;
    includeRecentMessages?: boolean | undefined;
    outputMode: "answer" | "reply" | "troubleshooting";
    sourceIp: string;
  },
): Promise<void> {
  if (!dependencies.weknora)
    return void reply.code(503).send({ error: "knowledge_unavailable" });
  if (!dependencies.model)
    return void reply.code(503).send({ error: "model_unavailable" });
  const tray = input.conversationId
    ? await getKnowledgeEvidenceTray(db, input.userId, input.conversationId)
    : [];
  const selected = tray.filter((item) =>
    input.selectedEvidenceIds.includes(item.evidenceId),
  );
  if (
    !input.conversationId ||
    selected.length !== new Set(input.selectedEvidenceIds).size
  ) {
    return void reply.code(409).send({ error: "evidence_tray_conflict" });
  }
  let thread: { threadId: string; weknoraSessionId: string };
  try {
    thread = await getOrCreateKnowledgeThread(db, dependencies.weknora, {
      userId: input.userId,
      threadId: input.threadId,
      title: input.query,
      conversationId: input.conversationId,
      scopeType: "conversation",
      sourceIp: input.sourceIp,
    });
    await appendKnowledgeThreadMessage(db, {
      userId: input.userId,
      threadId: thread.threadId,
      role: "user",
      content: input.query,
      metadata: queryOptionsMetadata({
        selectedEvidenceIds: input.selectedEvidenceIds,
        contextOverride: input.contextOverride,
        includeRecentMessages: input.includeRecentMessages,
      }),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "knowledge_thread_not_found"
    ) {
      return void reply.code(404).send({ error: "thread_not_found" });
    }
    return void reply.code(503).send({ error: "generation_failed" });
  }
  const baseContext = input.conversationId
    ? await getKnowledgeConversationContext(db, input.conversationId)
    : undefined;
  const context =
    baseContext && (input.contextOverride || input.includeRecentMessages)
      ? applyKnowledgeContextOverride(
          baseContext,
          input.contextOverride,
          input.includeRecentMessages && input.conversationId
            ? await recentConversationContext(db, input.conversationId)
            : undefined,
        )
      : baseContext;
  let answer: string;
  try {
    answer = await generateKnowledgeAnswerFromEvidence(dependencies.model, {
      query: input.query,
      evidence: selected,
      context,
    });
  } catch {
    return void reply.code(503).send({ error: "generation_failed" });
  }
  const references = selected as unknown as Record<string, unknown>[];
  const actionOutput = await buildKnowledgeActionOutput(dependencies.model, {
    answer,
    references,
    context,
  });
  const replySuggestion =
    input.outputMode === "reply" && context
      ? buildReplySuggestion(
          actionOutput.reply || answer,
          context.revision,
          references,
        )
      : undefined;
  await appendKnowledgeThreadMessage(db, {
    userId: input.userId,
    threadId: thread.threadId,
    role: "assistant",
    content: answer,
    references,
    metadata: assistantMetadata({
      actionOutput: actionOutput,
      conversationRevision: baseContext?.revision ?? null,
      replySuggestion,
    }),
    completed: true,
  });
  const streamId = randomUUID();
  reply.hijack();
  reply.raw.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  writeSse(reply, { type: "started", streamId, threadId: thread.threadId });
  writeSse(reply, { type: "references", references });
  writeSse(reply, { type: "answer", content: answer });
  writeSse(reply, { type: "action_output", output: actionOutput });
  if (replySuggestion) {
    writeSse(reply, { type: "reply_suggestion", suggestion: replySuggestion });
  }
  writeSse(reply, { type: "complete" });
  reply.raw.end();
}

async function forwardKnowledgeSse(
  reply: FastifyReply,
  upstream: Response,
  active: ActiveKnowledgeStream,
): Promise<boolean> {
  if (!upstream.body) return false;
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  while (!completed && !active.controller.signal.aborted) {
    const next = await reader.read();
    const chunk =
      next.value instanceof Uint8Array ? next.value : new Uint8Array();
    buffer += decoder.decode(chunk, {
      stream: !next.done,
    });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = parseKnowledgeFrame(frame, active);
      if (active.stopRequested && active.messageId) {
        await active.stopUpstream().catch(() => undefined);
        active.stopRequested = false;
      }
      if (!event) continue;
      if (event.type !== "complete" && event.type !== "stopped") {
        writeSse(reply, event);
      }
      if (event.type === "complete" || event.type === "stopped") {
        completed = true;
        break;
      }
    }
    if (next.done) break;
  }
  if (buffer.trim()) {
    const event = parseKnowledgeFrame(buffer, active);
    if (active.stopRequested && active.messageId) {
      await active.stopUpstream().catch(() => undefined);
      active.stopRequested = false;
    }
    if (event?.type === "complete" || event?.type === "stopped") {
      completed = true;
    } else if (event) {
      writeSse(reply, event);
    }
  }
  return completed;
}

function parseKnowledgeFrame(
  frame: string,
  active: ActiveKnowledgeStream,
): Record<string, unknown> | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!data || data === "[DONE]") return undefined;
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isRecord(parsed)) return undefined;
    payload = parsed;
  } catch {
    return undefined;
  }
  const responseType = stringValue(payload.response_type);
  if (responseType === "agent_query") {
    const messageId = stringValue(payload.assistant_message_id);
    if (messageId) active.messageId = messageId;
    return undefined;
  }
  if (responseType === "references") {
    const references = normalizeReferences(payload.knowledge_references);
    active.references = references;
    return {
      type: "references",
      references,
    };
  }
  if (responseType === "answer") {
    const content = stringValue(payload.content);
    active.answer += content;
    return { type: "answer", content };
  }
  if (responseType === "complete") return { type: "complete" };
  if (responseType === "stop") return { type: "stopped" };
  if (responseType === "error") {
    return { type: "error", code: "generation_failed" };
  }
  return undefined;
}

/** 收集上游知识问答流：完整回答 + 引用 → 建议回复（非 HTTP SSE，供 suggestion 端点用） */
async function collectKnowledgeSuggestion(
  upstream: Response,
  sourceRevision: number,
): Promise<ReplySuggestion | undefined> {
  if (!upstream.body) return undefined;
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let references: Record<string, unknown>[] = [];
  let done = false;
  while (!done) {
    const next = await reader.read();
    const chunk =
      next.value instanceof Uint8Array ? next.value : new Uint8Array();
    buffer += decoder.decode(chunk, { stream: !next.done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data);
        if (!isRecord(parsed)) continue;
        payload = parsed;
      } catch {
        continue;
      }
      const type =
        typeof payload.response_type === "string" ? payload.response_type : "";
      if (type === "answer")
        answer += typeof payload.content === "string" ? payload.content : "";
      else if (type === "references")
        references = normalizeReferences(payload.knowledge_references);
      else if (type === "complete" || type === "stop") done = true;
      else if (type === "error") return undefined;
    }
    if (next.done) break;
  }
  const text = answer.trim();
  if (!text) return undefined;
  return buildReplySuggestion(text, sourceRevision, references);
}

function normalizeReferences(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = stringValue(item.id);
    const title = stringValue(item.knowledge_title);
    const filename = stringValue(item.knowledge_filename);
    const excerpt = stringValue(item.content);
    if (!id && !excerpt) return [];
    return [
      {
        evidenceId: id,
        documentId: stringValue(item.knowledge_id),
        title,
        sourceName: filename,
        excerpt,
        locator:
          typeof item.start_at === "number"
            ? `片段 ${String(item.start_at)}`
            : undefined,
        sourceType: stringValue(item.chunk_type).includes("faq")
          ? "faq"
          : "file",
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function writeSse(reply: FastifyReply, value: Record<string, unknown>) {
  reply.raw.write(`data: ${JSON.stringify(value)}\n\n`);
  reply.raw.flushHeaders();
}

/**
 * Fast Path SSE：跳过检索，直接用 Brief + 最近消息本地生成回复草稿。
 * 事件序列与主路径一致（started → answer → reply_suggestion → complete），
 * 客户端无需感知差异；无知识依据时 evidenceIds 为空（UI 显示"依据当前会话"）。
 */
async function streamFastPathSuggestion(
  reply: FastifyReply,
  db: NodePgDatabase<typeof schema>,
  dependencies: KnowledgeRouteDependencies,
  input: {
    userId: string;
    query: string;
    conversationId: string;
    context: KnowledgeConversationContext;
    sourceIp: string;
  },
): Promise<void> {
  reply.hijack();
  writeSse(reply, {
    type: "started",
    streamId: `fast-path-${randomUUID()}`,
    threadId: "",
  });
  const recent = await recentConversationContext(db, input.conversationId);
  const answer = await generateReplyDraft(dependencies.model, {
    query: input.query,
    context: input.context,
    recentMessages: recent,
  });
  writeSse(reply, { type: "answer", content: answer });
  const suggestion = buildReplySuggestion(answer, input.context.revision, []);
  writeSse(reply, { type: "reply_suggestion", suggestion });
  writeSse(reply, { type: "complete" });
  reply.raw.end();
}

function buildReplySuggestion(
  text: string,
  sourceRevision: number,
  references: Record<string, unknown>[],
): ReplySuggestion {
  const evidenceIds = references.flatMap((reference) => {
    const evidenceId = reference.evidenceId;
    return typeof evidenceId === "string" ? [evidenceId] : [];
  });
  return {
    suggestionId: `reply-suggestion:${randomUUID()}`,
    text: normalizeSuggestionText(text),
    sourceRevision,
    generatedAt: new Date().toISOString(),
    evidenceIds,
    generationStatus: "complete",
  };
}

/** 线程消息元数据：记录本次查询选项与生成时的行动输出，供历史恢复使用。 */
function queryOptionsMetadata(input: {
  knowledgeBaseIds?: string[] | undefined;
  selectedEvidenceIds?: string[] | undefined;
  contextOverride?: KnowledgeContextOverride | undefined;
  includeRecentMessages?: boolean | undefined;
  depth?: "quick" | "deep" | undefined;
}): Record<string, unknown> {
  return {
    queryOptions: {
      knowledgeBaseIds: input.knowledgeBaseIds ?? [],
      selectedEvidenceIds: input.selectedEvidenceIds ?? [],
      contextOverride: input.contextOverride ?? null,
      includeRecentMessages: input.includeRecentMessages ?? false,
      depth: input.depth ?? "quick",
    },
  };
}

function assistantMetadata(input: {
  actionOutput?: Record<string, unknown> | undefined;
  conversationRevision?: number | null | undefined;
  replySuggestion?: ReplySuggestion | undefined;
}): Record<string, unknown> {
  return {
    actionOutput: input.actionOutput ?? null,
    conversationRevision: input.conversationRevision ?? null,
    replySuggestion: input.replySuggestion ?? null,
  };
}

/** 根据业务结果状态码映射为 HTTP 响应 */
function sendResult(
  reply: FastifyReply,
  result: Awaited<ReturnType<typeof retrieveClientKnowledge>>,
) {
  if (result.status === "ok") return reply.code(200).send(result.retrieval);
  if (result.status === "draft_ok") return reply.code(200).send(result.draft);
  const status =
    result.status === "not_assignee"
      ? 403
      : result.status === "not_found"
        ? 404
        : 503;
  return reply.code(status).send({ error: result.status });
}

function sendWorkspaceResult(
  reply: FastifyReply,
  result: Awaited<ReturnType<typeof searchKnowledgeWorkspace>>,
) {
  if (result.status === "ok") return reply.code(200).send(result.result);
  return reply.code(503).send({ error: result.status });
}
