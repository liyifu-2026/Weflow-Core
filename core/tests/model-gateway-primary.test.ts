/**
 * 配置收敛：resolvePrimaryTextModelName（text 槽位 = 文本主模型唯一事实源）。
 *
 * 钉住的契约：
 * - 槽位绑定了启用的注册表模型 → 返回链主 displayName（source: slot），
 *   与网关链实际请求的模型一致；
 * - 槽位未绑定 / 绑定的模型被禁用 → 回落旧 text_model 扁平键（legacy）；
 * - 槽位解析抛错不阻断，回落 legacy。
 */
import { describe, expect, it } from "vitest";
import { resolvePrimaryTextModelName } from "../modules/operations/application/model-gateway.js";

type RegistryRow = {
  modelId: string;
  displayName: string;
  baseUrl: string;
  apiKey: string | null;
  timeoutMs: number;
  capabilities: string[];
  failoverTo: string | null;
  enabled: boolean;
};

function makeDb(input: {
  settingsRows: { key: string; value: string }[];
  registryRows: RegistryRow[];
  throwOnSettings?: boolean;
}) {
  return {
    select() {
      return {
        from(table: unknown) {
          const record = table as Record<symbol, unknown>;
          const name = String(record[Symbol.for("drizzle:Name")] ?? "");
          if (name.includes("runtime_settings")) {
            if (input.throwOnSettings) {
              return Promise.reject(new Error("db unavailable"));
            }
            return Promise.resolve(input.settingsRows);
          }
          if (name.includes("model_registry")) {
            return Promise.resolve(input.registryRows);
          }
          return Promise.resolve([]);
        },
      };
    },
  } as never;
}

const registry = (overrides: Partial<RegistryRow> = {}): RegistryRow => ({
  modelId: "deepseekVision",
  displayName: "deepseek-v4-flash-vision-exp",
  baseUrl: "https://api.deepseek.com",
  apiKey: "sk-test",
  timeoutMs: 60_000,
  capabilities: ["text"],
  failoverTo: null,
  enabled: true,
  ...overrides,
});

describe("resolvePrimaryTextModelName", () => {
  it("text 槽位绑定启用模型时返回链主 displayName（slot）", async () => {
    const db = makeDb({
      settingsRows: [
        { key: "model_slot_text", value: "deepseekVision" },
        { key: "text_model", value: "deepseek-v4-flash" },
      ],
      registryRows: [registry()],
    });
    await expect(
      resolvePrimaryTextModelName(db, "deepseek-v4-flash"),
    ).resolves.toEqual({
      name: "deepseek-v4-flash-vision-exp",
      source: "slot",
    });
  });

  it("槽位未绑定时原样返回调用方的 legacy 值（text_model 旧键由调用方解析）", async () => {
    const db = makeDb({
      settingsRows: [],
      registryRows: [registry()],
    });
    await expect(
      resolvePrimaryTextModelName(db, "deepseek-v4-pro"),
    ).resolves.toEqual({ name: "deepseek-v4-pro", source: "legacy" });
  });

  it("绑定的模型被禁用时视为未绑定，回落 legacy", async () => {
    const db = makeDb({
      settingsRows: [{ key: "model_slot_text", value: "deepseekVision" }],
      registryRows: [registry({ enabled: false })],
    });
    await expect(
      resolvePrimaryTextModelName(db, "deepseek-v4-flash"),
    ).resolves.toEqual({ name: "deepseek-v4-flash", source: "legacy" });
  });

  it("槽位解析抛错不阻断，回落 legacy", async () => {
    const db = makeDb({
      settingsRows: [],
      registryRows: [],
      throwOnSettings: true,
    });
    await expect(
      resolvePrimaryTextModelName(db, "deepseek-v4-flash"),
    ).resolves.toEqual({ name: "deepseek-v4-flash", source: "legacy" });
  });
});
