/**
 * 数据库迁移执行脚本
 * 加载配置、创建数据库连接，执行 Drizzle ORM 迁移
 * 迁移文件位于项目根目录的 migrations/ 文件夹
 */
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadConfig } from "../config/config.js";
import { createLogger } from "../observability/logger.js";
import { createPostgres } from "./client.js";

const config = loadConfig();
const logger = createLogger(config, "database-migration");
const postgres = createPostgres(config.databaseUrl, logger);

try {
  await migrate(postgres.db, {
    migrationsFolder: resolve("migrations"),
  });
  logger.info("database migrations completed");
} finally {
  await postgres.close();
}
