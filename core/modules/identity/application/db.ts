import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../infrastructure/postgres/schema.js";

/**
 * 应用层暴露的数据库句柄类型。
 *
 * interface 层的路由适配器只依赖这个别名拿 db（传给认证守卫与 application
 * 服务），不直接 import infrastructure/postgres/schema——持久化词汇由
 * application 层持有（AGENTS.md 模块结构强制的接缝）。
 */
export type BusinessDb = NodePgDatabase<typeof schema>;
