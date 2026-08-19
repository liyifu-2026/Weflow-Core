/**
 * Phase 3 集成测试：Operator Control Plane —— runtime settings 数据层
 *
 * 覆盖：默认值 / 更新+审计 / 非 allowlist 模型拒绝 / 回滚（重新校验+新审计）/
 * 脏数据 fail-safe 回退默认值
 */
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import {
  DEFAULT_RUNTIME_SETTINGS,
  readRuntimeSettings,
  rollbackRuntimeSettings,
  updateRuntimeSettings,
} from "../modules/operations/application/runtime-settings.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const logger = createLogger({ logLevel: "silent" }, "runtime-settings-test");

integration("runtime settings（Operator Control Plane 数据层）", () => {
  let postgres: Postgres;
  const actor = "test-operator";

  beforeAll(() => {
    postgres = createPostgres(databaseUrl ?? "", logger);
  });

  afterAll(async () => {
    // 清理本测试产生的设置修改与审计（保留种子行）
    await postgres.db
      .delete(schema.auditEvents)
      .where(
        eq(schema.auditEvents.eventType, "operator.runtime_settings_updated"),
      );
    await postgres.db
      .delete(schema.auditEvents)
      .where(
        eq(
          schema.auditEvents.eventType,
          "operator.runtime_settings_rolled_back",
        ),
      );
    await postgres.db
      .update(schema.runtimeSettings)
      .set({ value: "true" })
      .where(eq(schema.runtimeSettings.key, "agent_enabled"));
    await postgres.close();
  });

  it("默认值为全部开启 + 允许模型", async () => {
    const settings = await readRuntimeSettings(postgres.db, logger, {
      fresh: true,
    });
    expect(settings).toEqual(DEFAULT_RUNTIME_SETTINGS);
  });

  it("更新写入 DB 并产生审计（previous/next + operationId）", async () => {
    const result = await updateRuntimeSettings(postgres.db, logger, {
      actorUserId: actor,
      sourceIp: "127.0.0.1",
      patch: { agentEnabled: false },
    });
    expect(result.changed).toEqual([
      { key: "agent_enabled", previous: "true", next: "false" },
    ]);
    expect(result.settings.agentEnabled).toBe(false);

    const fresh = await readRuntimeSettings(postgres.db, logger, {
      fresh: true,
    });
    expect(fresh.agentEnabled).toBe(false);

    const [event] = await postgres.db
      .select()
      .from(schema.auditEvents)
      .where(
        eq(schema.auditEvents.eventType, "operator.runtime_settings_updated"),
      )
      .orderBy(desc(schema.auditEvents.createdAt))
      .limit(1);
    if (!event) throw new Error("audit event missing");
    expect(event.metadata).toMatchObject({
      key: "agent_enabled",
      previousValue: "true",
      nextValue: "false",
    });
    expect(event.metadata.operationId).toBeTruthy();
  });

  it("非 allowlist 模型名被拒绝，DB 值不变", async () => {
    await expect(
      updateRuntimeSettings(postgres.db, logger, {
        actorUserId: actor,
        sourceIp: "127.0.0.1",
        patch: { textModel: "gpt-4" as never },
      }),
    ).rejects.toThrow(/not in allowlist/);
    const fresh = await readRuntimeSettings(postgres.db, logger, {
      fresh: true,
    });
    expect(fresh.textModel).toBe("deepseek-v4-flash");
  });

  it("回滚恢复上一份配置并重新校验 + 新审计", async () => {
    const result = await rollbackRuntimeSettings(postgres.db, logger, {
      actorUserId: actor,
      sourceIp: "127.0.0.1",
    });
    expect(result.rolledBack).toEqual([
      { key: "agent_enabled", previous: "false", next: "true" },
    ]);
    expect(result.settings.agentEnabled).toBe(true);

    const [event] = await postgres.db
      .select()
      .from(schema.auditEvents)
      .where(
        eq(
          schema.auditEvents.eventType,
          "operator.runtime_settings_rolled_back",
        ),
      )
      .orderBy(desc(schema.auditEvents.createdAt))
      .limit(1);
    if (!event) throw new Error("rollback audit event missing");
    expect(event.metadata).toMatchObject({
      key: "agent_enabled",
      previousValue: "false",
      nextValue: "true",
    });
  });

  it("脏数据 fail-safe：非法值回退默认值且不崩溃", async () => {
    await postgres.db
      .insert(schema.runtimeSettings)
      .values({ key: "auto_send_enabled", value: "maybe" })
      .onConflictDoUpdate({
        target: schema.runtimeSettings.key,
        set: { value: "maybe" },
      });
    const fresh = await readRuntimeSettings(postgres.db, logger, {
      fresh: true,
    });
    // 非法值 → 默认 true（fail-safe），其余字段不受影响
    expect(fresh.autoSendEnabled).toBe(true);
    expect(fresh.agentEnabled).toBe(true);
    // 恢复干净值
    await postgres.db
      .update(schema.runtimeSettings)
      .set({ value: "true" })
      .where(eq(schema.runtimeSettings.key, "auto_send_enabled"));
  });
});
