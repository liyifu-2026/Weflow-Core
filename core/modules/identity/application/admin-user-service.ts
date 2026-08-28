import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { hashPassword } from "../../../infrastructure/auth/password.js";
import * as schema from "../../../infrastructure/postgres/schema.js";
import {
  createClosedUser,
  generateInitialPassword,
} from "./identity-service.js";

type Database = NodePgDatabase<typeof schema>;
export type UserRole = "admin" | "operator";

export async function listManagedUsers(db: Database) {
  const rows = await db
    .select({
      userId: schema.users.userId,
      username: schema.users.username,
      role: schema.users.role,
      status: schema.users.status,
      mustChangePassword: schema.users.mustChangePassword,
      avatarFileId: schema.users.avatarFileId,
      createdAt: schema.users.createdAt,
      updatedAt: schema.users.updatedAt,
    })
    .from(schema.users)
    .orderBy(schema.users.createdAt);
  // 头像只暴露相对路径（与 AuthenticatedUser.avatarUrl 一致），不泄漏文件 ID；
  // 头像端点对已知用户始终有内容（上传 > 预设 > 默认预设）
  return rows.map((row) => ({
    userId: row.userId,
    username: row.username,
    role: row.role,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
    avatarUrl: `/api/v1/users/${row.userId}/avatar?v=${Math.floor(row.updatedAt.getTime() / 1_000)}`,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function createManagedUser(
  db: Database,
  input: {
    username: string;
    role: UserRole;
    actorUserId: string;
    sourceIp: string;
  },
) {
  const initialPassword = generateInitialPassword();
  const user = await createClosedUser(
    db,
    input.username,
    initialPassword,
    input.role,
    { userId: input.actorUserId, sourceIp: input.sourceIp },
  );
  return { user, initialPassword };
}

export async function updateManagedUser(
  db: Database,
  input: {
    userId: string;
    role?: UserRole;
    status?: "active" | "disabled";
    actorUserId: string;
    sourceIp: string;
  },
): Promise<
  | { status: "ok"; user: Awaited<ReturnType<typeof listManagedUsers>>[number] }
  | { status: "not_found" }
  | { status: "last_admin" }
> {
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext('weflow_active_admin_guard'))`,
    );
    const targets = await transaction
      .select()
      .from(schema.users)
      .where(eq(schema.users.userId, input.userId))
      .limit(1);
    const target = targets[0];
    if (!target) return { status: "not_found" as const };

    const removesActiveAdmin =
      target.role === "admin" &&
      target.status === "active" &&
      (input.role === "operator" || input.status === "disabled");
    if (removesActiveAdmin) {
      const activeAdmins = await transaction
        .select({ userId: schema.users.userId })
        .from(schema.users)
        .where(
          and(
            eq(schema.users.role, "admin"),
            eq(schema.users.status, "active"),
          ),
        );
      if (activeAdmins.length <= 1) return { status: "last_admin" as const };
    }

    const [updated] = await transaction
      .update(schema.users)
      .set({
        ...(input.role ? { role: input.role } : {}),
        ...(input.status ? { status: input.status } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.users.userId, input.userId))
      .returning({
        userId: schema.users.userId,
        username: schema.users.username,
        role: schema.users.role,
        status: schema.users.status,
        mustChangePassword: schema.users.mustChangePassword,
        avatarFileId: schema.users.avatarFileId,
        createdAt: schema.users.createdAt,
        updatedAt: schema.users.updatedAt,
      });
    if (!updated) return { status: "not_found" as const };
    const projected = {
      userId: updated.userId,
      username: updated.username,
      role: updated.role,
      status: updated.status,
      mustChangePassword: updated.mustChangePassword,
      avatarUrl: `/api/v1/users/${updated.userId}/avatar?v=${Math.floor(updated.updatedAt.getTime() / 1_000)}`,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };

    if (input.role || input.status === "disabled") {
      await transaction
        .update(schema.userSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.userSessions.userId, input.userId),
            isNull(schema.userSessions.revokedAt),
          ),
        );
    }
    await transaction.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId: input.actorUserId,
      eventType: "identity.user_updated",
      subjectType: "user",
      subjectId: input.userId,
      sourceIp: input.sourceIp,
      metadata: {
        ...(input.role ? { role: input.role } : {}),
        ...(input.status ? { status: input.status } : {}),
      },
    });
    return { status: "ok" as const, user: projected };
  });
}

export async function resetManagedPassword(
  db: Database,
  input: { userId: string; actorUserId: string; sourceIp: string },
): Promise<{ initialPassword: string } | undefined> {
  const initialPassword = generateInitialPassword();
  const passwordHash = await hashPassword(initialPassword);
  return db.transaction(async (transaction) => {
    const [updated] = await transaction
      .update(schema.users)
      .set({ passwordHash, mustChangePassword: true, updatedAt: new Date() })
      .where(eq(schema.users.userId, input.userId))
      .returning({ userId: schema.users.userId });
    if (!updated) return undefined;
    await transaction
      .update(schema.userSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.userSessions.userId, input.userId),
          isNull(schema.userSessions.revokedAt),
        ),
      );
    await transaction.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId: input.actorUserId,
      eventType: "identity.password_reset",
      subjectType: "user",
      subjectId: input.userId,
      sourceIp: input.sourceIp,
      metadata: {},
    });
    return { initialPassword };
  });
}

export async function revokeManagedSessions(
  db: Database,
  input: { userId: string; actorUserId: string; sourceIp: string },
): Promise<boolean> {
  const users = await db
    .select({ userId: schema.users.userId })
    .from(schema.users)
    .where(eq(schema.users.userId, input.userId))
    .limit(1);
  if (!users[0]) return false;
  await db.transaction(async (transaction) => {
    await transaction
      .update(schema.userSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.userSessions.userId, input.userId),
          isNull(schema.userSessions.revokedAt),
        ),
      );
    await transaction.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId: input.actorUserId,
      eventType: "identity.sessions_revoked",
      subjectType: "user",
      subjectId: input.userId,
      sourceIp: input.sourceIp,
      metadata: {},
    });
  });
  return true;
}
