import { like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import {
  claimSolutionOperation,
  completeSolutionOperation,
  createSolutionOperation,
  getSolutionInstallation,
  startSolutionOperation,
} from "../modules/solution/application/solution-installation-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Solution Installation service state machine", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const solutionId = `weflow.test-solution-${suffix}`;
  let sequence = 0;

  beforeAll(() => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "solution-installation-test"),
    );
  });

  afterAll(async () => {
    await postgres.db
      .delete(schema.solutionEvents)
      .where(
        like(
          schema.solutionEvents.solutionId,
          `weflow.test-solution-${suffix}%`,
        ),
      );
    await postgres.db
      .delete(schema.solutionOperations)
      .where(
        like(
          schema.solutionOperations.solutionId,
          `weflow.test-solution-${suffix}%`,
        ),
      );
    await postgres.db
      .delete(schema.solutionVersions)
      .where(
        like(
          schema.solutionVersions.solutionId,
          `weflow.test-solution-${suffix}%`,
        ),
      );
    await postgres.db
      .delete(schema.solutionResourceOwnership)
      .where(
        like(
          schema.solutionResourceOwnership.solutionId,
          `weflow.test-solution-${suffix}%`,
        ),
      );
    await postgres.db
      .delete(schema.solutionInstallations)
      .where(
        like(
          schema.solutionInstallations.solutionId,
          `weflow.test-solution-${suffix}%`,
        ),
      );
    await postgres.close();
  });

  it("installs, activates, and rejects invalid transitions", async () => {
    const installKey = `install-${suffix}-${String(++sequence)}`;
    const install = await createSolutionOperation(postgres.db, {
      solutionId,
      type: "install",
      idempotencyKey: installKey,
      actor: "admin@test",
      solutionVersion: "1.0.0",
      manifest: {
        apiVersion: "weflow.io/v1",
        kind: "Solution",
        metadata: {
          id: solutionId,
          name: "Test Solution",
          version: "1.0.0",
          publisher: "weflow",
        },
      },
      lock: {
        apiVersion: "weflow.io/v1",
        kind: "SolutionLock",
        solutionId,
        solutionVersion: "1.0.0",
        manifestDigest: `sha256:${"a".repeat(64)}`,
        dependencies: [],
        artifacts: [],
      },
      signature: {
        algorithm: "ed25519",
        keyId: "test-key",
        digest: `sha256:${"a".repeat(64)}`,
        signature: "test-signature",
      },
    });
    expect(install.status).toBe("ok");
    if (install.status !== "ok") return;

    const claimed = await claimSolutionOperation(postgres.db, {
      operationId: install.data.operationId,
      runnerId: "runner-1",
    });
    expect(claimed.status).toBe("ok");
    if (claimed.status !== "ok") return;
    expect(claimed.data.state).toBe("claimed");

    const started = await startSolutionOperation(postgres.db, {
      operationId: install.data.operationId,
      runnerId: "runner-1",
    });
    expect(started.status).toBe("ok");
    if (started.status !== "ok") return;
    expect(started.data.state).toBe("running");

    const completed = await completeSolutionOperation(postgres.db, {
      operationId: install.data.operationId,
      runnerId: "runner-1",
      solutionVersion: "1.0.0",
    });
    expect(completed.status).toBe("ok");
    if (completed.status !== "ok") return;
    expect(completed.data.state).toBe("succeeded");

    const installed = await getSolutionInstallation(postgres.db, solutionId);
    expect(installed).toMatchObject({
      solutionId,
      version: "1.0.0",
      desiredState: "disabled",
      observedState: "installed",
    });

    const activateKey = `activate-${suffix}-${String(++sequence)}`;
    const activate = await createSolutionOperation(postgres.db, {
      solutionId,
      type: "activate",
      idempotencyKey: activateKey,
      actor: "admin@test",
    });
    expect(activate.status).toBe("ok");
    if (activate.status !== "ok") return;

    const activateClaimed = await claimSolutionOperation(postgres.db, {
      operationId: activate.data.operationId,
      runnerId: "runner-1",
    });
    expect(activateClaimed.status).toBe("ok");
    if (activateClaimed.status !== "ok") return;
    await startSolutionOperation(postgres.db, {
      operationId: activate.data.operationId,
      runnerId: "runner-1",
    });
    const activateCompleted = await completeSolutionOperation(postgres.db, {
      operationId: activate.data.operationId,
      runnerId: "runner-1",
    });
    expect(activateCompleted.status).toBe("ok");
    if (activateCompleted.status !== "ok") return;

    const active = await getSolutionInstallation(postgres.db, solutionId);
    expect(active).toMatchObject({
      desiredState: "active",
      observedState: "active",
    });

    const invalidInstall = await createSolutionOperation(postgres.db, {
      solutionId,
      type: "install",
      idempotencyKey: `invalid-install-${suffix}-${String(++sequence)}`,
      actor: "admin@test",
    });
    expect(invalidInstall.status).toBe("invalid_transition");
  });

  it("returns the same operation for the same idempotency key", async () => {
    const key = `idem-${suffix}-${String(++sequence)}`;
    const first = await createSolutionOperation(postgres.db, {
      solutionId,
      type: "disable",
      idempotencyKey: key,
      actor: "admin@test",
    });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    const second = await createSolutionOperation(postgres.db, {
      solutionId,
      type: "disable",
      idempotencyKey: key,
      actor: "admin@test",
    });
    expect(second.status).toBe("ok");
    if (second.status !== "ok") return;
    expect(second.data.operationId).toBe(first.data.operationId);
  });
});
