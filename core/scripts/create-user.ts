/**
 * 创建用户脚本
 *
 * 用途：命令行工具，用于创建新的封闭用户（Closed User）
 * 用法：pnpm create-user <username>
 *
 * 执行后会生成一个随机初始密码，仅显示一次
 */
import { loadConfig } from "../infrastructure/config/config.js";
import { createLogger } from "../infrastructure/observability/logger.js";
import { createPostgres } from "../infrastructure/postgres/client.js";
import {
  createClosedUser,
  generateInitialPassword,
} from "../modules/identity/application/identity-service.js";
import { verifyPassword } from "../infrastructure/auth/password.js";
import { eq } from "drizzle-orm";
import * as schema from "../infrastructure/postgres/schema.js";

// 从命令行参数获取用户名
const username = process.argv[2];
if (!username) {
  throw new Error("usage: pnpm create-user <username> [--role=admin|operator]");
}
const roleArg = process.argv.find((argument) => argument.startsWith("--role="));
const roleValue = roleArg?.slice("--role=".length) ?? "operator";
if (roleValue !== "admin" && roleValue !== "operator") {
  throw new Error("role must be admin or operator");
}

// 加载配置并初始化数据库连接
const config = loadConfig();
const postgres = createPostgres(
  config.databaseUrl,
  createLogger({ logLevel: "silent" }, "create-user"),
);
try {
  // 生成随机初始密码
  const initialPassword = generateInitialPassword();
  // 创建封闭用户并写入数据库
  const user = await createClosedUser(
    postgres.db,
    username,
    initialPassword,
    roleValue,
  );
  // 重新读取哈希并验证密码匹配，防止哈希参数不一致
  const rows = await postgres.db
    .select({ passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.userId, user.userId))
    .limit(1);
  const storedHash = rows[0]?.passwordHash;
  if (!storedHash || !(await verifyPassword(storedHash, initialPassword))) {
    throw new Error("FATAL: password hash verification failed after creation");
  }
  // 输出创建结果和初始密码（仅显示一次）
  process.stdout.write(
    `created ${user.role} ${user.username}\ninitial password (shown once): ${initialPassword}\n`,
  );
} finally {
  // 确保关闭数据库连接
  await postgres.close();
}
