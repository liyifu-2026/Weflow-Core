/**
 * Drizzle ORM 配置文件
 *
 * 用途：配置 Drizzle Kit 的数据库迁移工具
 * - 指定 PostgreSQL 数据库连接
 * - 定义 schema 文件位置
 * - 配置迁移输出目录
 */
import { defineConfig } from "drizzle-kit";

// 数据库连接 URL，优先使用环境变量，否则使用本地默认值
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://weflow:weflow@127.0.0.1:5432/weflow";

export default defineConfig({
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
  out: "./migrations", // 迁移文件输出目录
  schema: "./infrastructure/postgres/schema.ts", // schema 定义文件路径
  strict: true, // 启用严格模式
  verbose: true, // 启用详细日志
});
