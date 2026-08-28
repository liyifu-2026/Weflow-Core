/**
 * 重置用户密码脚本
 *
 * 用途：命令行工具，用于重置指定用户的密码
 * 用法：pnpm reset-password <username> [--password=<password>]
 *
 * 如果不指定 --password，则生成随机密码
 * 重置后会验证新密码是否能正确匹配哈希
 */
import { loadConfig } from "../infrastructure/config/config.js";
import { createLogger } from "../infrastructure/observability/logger.js";
import { createPostgres } from "../infrastructure/postgres/client.js";
import {
  generateInitialPassword,
} from "../modules/identity/application/identity-service.js";
import { hashPassword, verifyPassword } from "../infrastructure/auth/password.js";
import { eq } from "drizzle-orm";
import * as schema from "../infrastructure/postgres/schema.js";

const username = process.argv[2];
if (!username) {
  throw new Error("usage: pnpm reset-password <username> [--password=<password>]");
}

const passwordArg = process.argv.find((a) => a.startsWith("--password="));
const newPassword = passwordArg
  ? passwordArg.slice("--password=".length)
  : generateInitialPassword();

if (newPassword.length < 12 || newPassword.length > 128) {
  throw new Error("password must be between 12 and 128 characters");
}

const config = loadConfig();
const postgres = createPostgres(
  config.databaseUrl,
  createLogger({ logLevel: "silent" }, "reset-password"),
);

try {
  // 查找用户
  const rows = await postgres.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username.toLowerCase().trim()))
    .limit(1);
  const user = rows[0];
  if (!user) {
    throw new Error(`user "${username}" not found`);
  }

  // 哈希新密码
  const passwordHash = await hashPassword(newPassword);

  // 验证哈希与明文匹配
  const verified = await verifyPassword(passwordHash, newPassword);
  if (!verified) {
    throw new Error("FATAL: hash verification failed after creation — aborting");
  }

  // 更新数据库
  await postgres.db
    .update(schema.users)
    .set({ passwordHash, mustChangePassword: true, updatedAt: new Date() })
    .where(eq(schema.users.userId, user.userId));

  process.stdout.write(
    `password reset for ${user.username} (${user.role})\nnew password (shown once): ${newPassword}\n`,
  );
} finally {
  await postgres.close();
}
