/**
 * PostgreSQL 数据库客户端
 * 使用 node-postgres 连接池和 Drizzle ORM 提供数据库访问
 */
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Logger } from "pino";
import * as schema from "./schema.js";

/** PostgreSQL 客户端类型，包含数据库实例、健康检查和关闭方法 */
export type Postgres = {
  db: NodePgDatabase<typeof schema>;
  check: () => Promise<void>;
  close: () => Promise<void>;
};

/**
 * 创建 PostgreSQL 客户端实例
 * @param databaseUrl - 数据库连接字符串
 * @param logger - 日志记录器
 * @returns 包含数据库实例和生命周期方法的对象
 */
export function createPostgres(databaseUrl: string, logger: Logger): Postgres {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10, // 最大连接数
  });
  pool.on("error", (error) => {
    logger.error({ err: error }, "unexpected PostgreSQL pool error");
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    check: async () => {
      await db.execute(sql`select 1`);
    },
    close: async () => {
      await pool.end();
    },
  };
}
