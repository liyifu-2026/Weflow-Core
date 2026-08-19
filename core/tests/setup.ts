/**
 * 集成测试全局守卫
 *
 * 集成测试直连数据库执行真实写入与删除，必须保证连接的**不是**生产库：
 * 未显式设置 TEST_DATABASE_URL（专门为测试创建的库）时全部集成测试跳过；
 * 设置了但库名不含 "test" 时直接抛错终止测试进程，双重护栏防误伤生产数据。
 *
 * 另外，在测试库中确保存在一个 active 的 Execution Profile，让 Agent Turn
 * 准入测试可以在没有生产 seed（platform-default 已移除）的情况下运行。
 */
import { beforeAll } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  let postgres: Postgres | undefined;
  try {
    const database =
      new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    if (!database.toLowerCase().includes("test")) {
      throw new Error(
        `TEST_DATABASE_URL must point to a database whose name contains "test" (got "${database}")`,
      );
    }
    postgres = createPostgres(
      url,
      createLogger({ logLevel: "silent" }, "test-setup"),
    );
    await postgres.db
      .insert(schema.agentExecutionProfiles)
      .values({
        profileId: "platform-default",
        solutionId: "weflow.platform",
        solutionVersion: "1.0.0",
        strategyRef: "weflow.platform/generic-v1",
        strategyVersion: "1.0.0",
        maxModelCalls: 2,
        maxToolCalls: 1,
        timeoutSeconds: 60,
        allowedTools: [],
        skills: [],
        status: "active",
      })
      .onConflictDoNothing();
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("TEST_DATABASE_URL is not a valid URL", {
        cause: error,
      });
    }
    throw error;
  } finally {
    await postgres?.close();
  }
});
