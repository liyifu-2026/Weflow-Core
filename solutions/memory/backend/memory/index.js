export async function registerRoutes(server, ctx) {
  const { db, schema, count, desc } = ctx;

  server.get("/memory/status", async () => {
    const [memories, captureStates] = await Promise.all([
      db.select({ value: count() }).from(schema.memories),
      db.select({ value: count() }).from(schema.memoryCaptureStates),
    ]);
    const totalMemories = memories[0]?.value ?? 0;
    const captureConversations = captureStates[0]?.value ?? 0;
    return {
      service: "memory",
      totalMemories,
      captureConversations,
      value: totalMemories,
      unit: "条",
    };
  });

  async function requireUser(request, reply) {
    const identity = await ctx.requireBusinessIdentity(ctx.db, request, reply);
    return identity ?? undefined;
  }

  server.post("/memory/memories", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const body = request.body ?? {};
    if (
      typeof body.contactId !== "string" ||
      typeof body.memoryKey !== "string" ||
      typeof body.content !== "string"
    ) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const memoryId = `memory_${crypto.randomUUID().replace(/-/g, "")}`;
    await db.insert(schema.memories).values({
      memoryId,
      contactId: body.contactId,
      kind: String(body.kind ?? "fact"),
      memoryKey: body.memoryKey,
      content: body.content,
      status: "candidate",
      confidence: Number(body.confidence) || 1,
      evidenceMessageIds: Array.isArray(body.evidenceMessageIds)
        ? body.evidenceMessageIds
        : [],
      extractedByModel: "manual",
    });
    return { memoryId };
  });

  server.get("/memory/memories", async () => {
    const rows = await db
      .select({
        memoryId: schema.memories.memoryId,
        contactId: schema.memories.contactId,
        kind: schema.memories.kind,
        memoryKey: schema.memories.memoryKey,
        content: schema.memories.content,
        status: schema.memories.status,
        confidence: schema.memories.confidence,
        updatedAt: schema.memories.updatedAt,
      })
      .from(schema.memories)
      .orderBy(desc(schema.memories.updatedAt))
      .limit(50);
    return { memories: rows };
  });

  server.get("/memory/capture-states", async () => {
    const rows = await db
      .select({
        conversationId: schema.memoryCaptureStates.conversationId,
        status: schema.memoryCaptureStates.status,
        extractedCount: schema.memoryCaptureStates.extractedCount,
        errorCode: schema.memoryCaptureStates.errorCode,
        updatedAt: schema.memoryCaptureStates.updatedAt,
      })
      .from(schema.memoryCaptureStates)
      .orderBy(desc(schema.memoryCaptureStates.updatedAt))
      .limit(50);
    return { captureStates: rows };
  });
}
