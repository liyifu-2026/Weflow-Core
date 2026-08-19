import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { loadConfig } from "../infrastructure/config/config.js";
import { createLogger } from "../infrastructure/observability/logger.js";
import { createPostgres } from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";

const username = process.argv[2]?.trim().toLowerCase();
if (!username) throw new Error("usage: pnpm promote-admin <username>");

const config = loadConfig();
const postgres = createPostgres(
  config.databaseUrl,
  createLogger({ logLevel: "silent" }, "promote-admin"),
);
try {
  const [user] = await postgres.db
    .update(schema.users)
    .set({ role: "admin", status: "active", updatedAt: new Date() })
    .where(eq(schema.users.username, username))
    .returning({
      userId: schema.users.userId,
      username: schema.users.username,
    });
  if (!user) throw new Error(`user ${username} does not exist`);
  await postgres.db.insert(schema.auditEvents).values({
    auditId: randomUUID(),
    actorUserId: null,
    eventType: "identity.admin_bootstrapped",
    subjectType: "user",
    subjectId: user.userId,
    sourceIp: null,
    metadata: { username: user.username, method: "closed_cli" },
  });
  process.stdout.write(`promoted admin ${user.username}\n`);
} finally {
  await postgres.close();
}
