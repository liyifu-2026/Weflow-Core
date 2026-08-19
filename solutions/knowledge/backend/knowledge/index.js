export async function registerRoutes(server, ctx) {
  const { db, schema, count, gte, desc } = ctx;

  server.get("/knowledge/retrievals", async () => {
    const rows = await db
      .select({
        retrievalId: schema.clientKnowledgeRetrievals.retrievalId,
        conversationId: schema.clientKnowledgeRetrievals.conversationId,
        userId: schema.clientKnowledgeRetrievals.userId,
        query: schema.clientKnowledgeRetrievals.query,
        status: schema.clientKnowledgeRetrievals.status,
        createdAt: schema.clientKnowledgeRetrievals.createdAt,
      })
      .from(schema.clientKnowledgeRetrievals)
      .orderBy(desc(schema.clientKnowledgeRetrievals.createdAt))
      .limit(20);
    return { retrievals: rows };
  });

  server.get("/knowledge/threads", async () => {
    const rows = await db
      .select({
        threadId: schema.clientKnowledgeThreads.threadId,
        userId: schema.clientKnowledgeThreads.userId,
        scopeType: schema.clientKnowledgeThreads.scopeType,
        scopeId: schema.clientKnowledgeThreads.scopeId,
        title: schema.clientKnowledgeThreads.title,
        updatedAt: schema.clientKnowledgeThreads.updatedAt,
      })
      .from(schema.clientKnowledgeThreads)
      .orderBy(desc(schema.clientKnowledgeThreads.updatedAt))
      .limit(20);
    return { threads: rows };
  });

  async function requireUser(request, reply) {
    const identity = await ctx.requireBusinessIdentity(ctx.db, request, reply);
    return identity ?? undefined;
  }

  server.post("/knowledge/retrievals", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const body = request.body ?? {};
    if (typeof body.query !== "string" || !body.query.trim()) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const retrievalId = `retrieval:${crypto.randomUUID()}`;
    await db.insert(schema.clientKnowledgeRetrievals).values({
      retrievalId,
      conversationId: String(body.conversationId ?? "standalone"),
      userId: user.user.userId,
      query: body.query,
      conversationRevision: Number(body.conversationRevision) || 0,
      evidence: Array.isArray(body.evidence) ? body.evidence : [],
      status: "completed",
    });
    return { retrievalId };
  });

  server.post("/knowledge/threads", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const body = request.body ?? {};
    if (typeof body.title !== "string" || !body.title.trim()) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const threadId = `knowledge-thread:${crypto.randomUUID()}`;
    await db.insert(schema.clientKnowledgeThreads).values({
      threadId,
      userId: user.user.userId,
      scopeType: String(body.scopeType ?? "standalone"),
      scopeId: String(body.scopeId ?? "standalone"),
      weknoraSessionId: String(body.weknoraSessionId ?? threadId),
      title: body.title,
    });
    return { threadId };
  });

  server.get("/knowledge/bases", async (request, reply) => {
    const client = ctx.services?.knowledgeClient;
    if (!client)
      return reply.code(503).send({ error: "knowledge_not_configured" });
    try {
      const bases = await client.listKnowledgeBases();
      return { bases };
    } catch {
      return reply.code(502).send({ error: "knowledge_provider_failed" });
    }
  });

  server.post("/knowledge/search", async (request, reply) => {
    const client = ctx.services?.knowledgeClient;
    if (!client)
      return reply.code(503).send({ error: "knowledge_not_configured" });
    const body = request.body ?? {};
    if (typeof body.query !== "string" || !body.query.trim()) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    try {
      const evidence = await client.search(body.query, {
        limit: Number(body.limit) || 6,
      });
      return { evidence };
    } catch {
      return reply.code(502).send({ error: "knowledge_provider_failed" });
    }
  });

  server.get("/knowledge/status", async () => {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [retrievals, threads] = await Promise.all([
      db
        .select({ value: count() })
        .from(schema.clientKnowledgeRetrievals)
        .where(gte(schema.clientKnowledgeRetrievals.createdAt, since24h)),
      db
        .select({ value: count() })
        .from(schema.clientKnowledgeThreads),
    ]);
    const todayRetrievals = retrievals[0]?.value ?? 0;
    const totalThreads = threads[0]?.value ?? 0;
    return {
      service: "knowledge",
      todayRetrievals,
      totalThreads,
      value: todayRetrievals,
      unit: "次",
    };
  });
}
