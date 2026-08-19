/**
 * Solution Runner HTTP routes.
 *
 * These routes are only reachable with the RUNNER_TOKEN machine identity.
 * They let the Runner claim/start/checkpoint/complete/fail operations and fetch
 * the operation payload. They intentionally do not expose Console admin APIs.
 */
import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import { requireRunnerIdentity } from "../../identity/interface/request-authentication.js";
import {
  claimSolutionOperation,
  completeSolutionOperation,
  failSolutionOperation,
  getSolutionOperationPayload,
  listClaimableSolutionOperations,
  listSecretAssignments,
  startSolutionOperation,
  updateSolutionOperationCheckpoint,
} from "../application/solution-installation-service.js";

const operationParamsSchema = z.object({
  operationId: z.string().trim().min(1).max(100),
});
const solutionParamsSchema = z.object({
  solutionId: z.string().trim().min(1).max(200),
});

const claimSchema = z
  .object({
    leaseTtlMs: z.number().int().positive().max(3_600_000).optional(),
  })
  .strict();

const checkpointSchema = z
  .object({
    checkpoint: z.string().trim().min(1).max(200),
  })
  .strict();

const completeSchema = z
  .object({
    solutionVersion: z.string().trim().min(1).max(50).optional(),
    checkpoint: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const failSchema = z
  .object({
    errorCode: z.string().trim().min(1).max(100),
    checkpoint: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

function sendServiceResult(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  result:
    | { status: "ok"; data: unknown }
    | { status: "invalid_transition"; reason: string }
    | { status: "not_found" }
    | { status: "idempotency_conflict" }
    | { status: "lease_conflict" },
) {
  switch (result.status) {
    case "ok":
      return result.data;
    case "invalid_transition":
      return reply.code(409).send({ error: result.reason });
    case "not_found":
      return reply.code(404).send({ error: "not_found" });
    case "idempotency_conflict":
      return reply.code(409).send({ error: "idempotency_conflict" });
    case "lease_conflict":
      return reply.code(409).send({ error: "lease_conflict" });
  }
}

export function registerSolutionRunnerRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
): void {
  server.get("/api/v1/runner/solution-operations", async (request, reply) => {
    const identity = await requireRunnerIdentity(request, reply);
    if (!identity) return;
    return { operations: await listClaimableSolutionOperations(db) };
  });

  server.get(
    "/api/v1/runner/solution-operations/:operationId/payload",
    async (request, reply) => {
      const identity = await requireRunnerIdentity(request, reply);
      const params = operationParamsSchema.safeParse(request.params);
      if (!identity || !params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const payload = await getSolutionOperationPayload(
        db,
        params.data.operationId,
      );
      return payload
        ? { payload }
        : reply.code(404).send({ error: "not_found" });
    },
  );

  server.get(
    "/api/v1/runner/solutions/:solutionId/secrets",
    async (request, reply) => {
      const identity = await requireRunnerIdentity(request, reply);
      const params = solutionParamsSchema.safeParse(request.params);
      if (!identity || !params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const assignments = await listSecretAssignments(
        db,
        params.data.solutionId,
      );
      return { assignments };
    },
  );

  server.post(
    "/api/v1/runner/solution-operations/:operationId/claim",
    async (request, reply) => {
      const identity = await requireRunnerIdentity(request, reply);
      const params = operationParamsSchema.safeParse(request.params);
      const body = claimSchema.safeParse(request.body ?? {});
      if (!identity || !params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      const result = await claimSolutionOperation(db, {
        operationId: params.data.operationId,
        runnerId: identity.runnerId,
        ...(body.data.leaseTtlMs === undefined
          ? {}
          : { leaseTtlMs: body.data.leaseTtlMs }),
      });
      return sendServiceResult(reply, result);
    },
  );

  server.post(
    "/api/v1/runner/solution-operations/:operationId/start",
    async (request, reply) => {
      const identity = await requireRunnerIdentity(request, reply);
      const params = operationParamsSchema.safeParse(request.params);
      if (!identity || !params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const result = await startSolutionOperation(db, {
        operationId: params.data.operationId,
        runnerId: identity.runnerId,
      });
      return sendServiceResult(reply, result);
    },
  );

  server.post(
    "/api/v1/runner/solution-operations/:operationId/checkpoint",
    async (request, reply) => {
      const identity = await requireRunnerIdentity(request, reply);
      const params = operationParamsSchema.safeParse(request.params);
      const body = checkpointSchema.safeParse(request.body);
      if (!identity || !params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      const result = await updateSolutionOperationCheckpoint(db, {
        operationId: params.data.operationId,
        runnerId: identity.runnerId,
        checkpoint: body.data.checkpoint,
      });
      return sendServiceResult(reply, result);
    },
  );

  server.post(
    "/api/v1/runner/solution-operations/:operationId/complete",
    async (request, reply) => {
      const identity = await requireRunnerIdentity(request, reply);
      const params = operationParamsSchema.safeParse(request.params);
      const body = completeSchema.safeParse(request.body ?? {});
      if (!identity || !params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      const result = await completeSolutionOperation(db, {
        operationId: params.data.operationId,
        runnerId: identity.runnerId,
        ...(body.data.solutionVersion === undefined
          ? {}
          : { solutionVersion: body.data.solutionVersion }),
        ...(body.data.checkpoint === undefined
          ? {}
          : { checkpoint: body.data.checkpoint }),
      });
      return sendServiceResult(reply, result);
    },
  );

  server.post(
    "/api/v1/runner/solution-operations/:operationId/fail",
    async (request, reply) => {
      const identity = await requireRunnerIdentity(request, reply);
      const params = operationParamsSchema.safeParse(request.params);
      const body = failSchema.safeParse(request.body ?? {});
      if (!identity || !params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      const result = await failSolutionOperation(db, {
        operationId: params.data.operationId,
        runnerId: identity.runnerId,
        errorCode: body.data.errorCode,
        ...(body.data.checkpoint === undefined
          ? {}
          : { checkpoint: body.data.checkpoint }),
      });
      return sendServiceResult(reply, result);
    },
  );
}
