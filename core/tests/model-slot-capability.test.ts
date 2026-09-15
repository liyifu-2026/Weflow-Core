/**
 * 槽位绑定能力校验 + 运行时兜底（0073 协议字段顺带覆盖）。
 *
 * 钉住的契约：
 * - 绑定模型能力不符（asr 槽位绑纯文本模型）→ capabilityMismatch 拒绝，
 *   不落库不写审计（2026-09-05 故障：deepseekVision 被绑上 asr 槽位）；
 * - 绕过接口直接改库产生的错误绑定，运行时解析过滤为空链 → 消费方回落
 *   .env 旧配置，不把音频发给纯文本端点；
 * - protocol 缺省/非法值回落 chat_inline（旧行为不变）。
 */
import { describe, expect, it } from "vitest";
import {
  bindModelSlot,
  resolveSlotChainRuntime,
} from "../modules/operations/application/model-gateway.js";

type RegistryRow = {
  modelId: string;
  displayName: string;
  baseUrl: string;
  apiKey: string | null;
  capabilities: string[];
  protocol?: string | null;
  timeoutMs: number;
  failoverTo: string | null;
  enabled: boolean;
};

type SettingsRow = { key: string; value: string; updatedBy?: string };

function makeDb(input: {
  settingsRows?: SettingsRow[];
  registryRows?: RegistryRow[];
  writtenSettings?: SettingsRow[];
  writtenAudit?: unknown[];
}) {
  const written = input.writtenSettings ?? [];
  const audit = input.writtenAudit ?? [];
  return {
    select() {
      const resolveRows = (table: unknown): Promise<unknown[]> => {
        const record = table as Record<symbol, unknown>;
        const name = String(record[Symbol.for("drizzle:Name")] ?? "");
        if (name.includes("runtime_settings")) {
          return Promise.resolve(input.settingsRows ?? []);
        }
        if (name.includes("model_registry")) {
          return Promise.resolve(input.registryRows ?? []);
        }
        return Promise.resolve([]);
      };
      const chain = (
        table: unknown,
      ): { from: () => Record<string, unknown> } => ({
        from: () => ({
          where: () => ({
            limit: async () => (await resolveRows(table)).slice(0, 1),
          }),
          then: (res: (v: unknown[]) => unknown) => resolveRows(table).then(res),
        }),
      });
      return {
        from: (table: unknown) => chain(table).from(),
      };
    },
    insert(table: unknown) {
      const record = table as Record<symbol, unknown>;
      const name = String(record[Symbol.for("drizzle:Name")] ?? "");
      return {
        values(value: unknown) {
          if (name.includes("runtime_settings")) written.push(value as SettingsRow);
          if (name === "events") audit.push(value);
          return {
            onConflictDoUpdate() {
              return { then: Promise.resolve() } as never;
            },
            then: Promise.resolve() as never,
          };
        },
      };
    },
    _written: written,
    _audit: audit,
  } as never & { _written: SettingsRow[]; _audit: unknown[] };
}

const registry = (overrides: Partial<RegistryRow> = {}): RegistryRow => ({
  modelId: "xingchen-asr",
  displayName: "XingChenAGI/XingChenASR-V3.2-Ultra",
  baseUrl: "https://api.siliconflow.cn/v1",
  apiKey: "sk-test",
  capabilities: ["asr"],
  protocol: "audio_transcriptions",
  timeoutMs: 60_000,
  failoverTo: null,
  enabled: true,
  ...overrides,
});

const ACTOR = { actorUserId: "admin-1", sourceIp: "127.0.0.1" };

describe("bindModelSlot 能力校验", () => {
  it("asr 槽位绑无 asr 能力的模型 → capabilityMismatch 拒绝，不落库", async () => {
    const written: SettingsRow[] = [];
    const audit: unknown[] = [];
    const db = makeDb({
      registryRows: [
        registry({ modelId: "deepseekVision", capabilities: ["text", "vision"] }),
      ],
      writtenSettings: written,
      writtenAudit: audit,
    });
    const result = await bindModelSlot(db as never, {
      ...ACTOR,
      slot: "asr",
      modelId: "deepseekVision",
    });
    expect(result).toEqual({ bound: false, capabilityMismatch: true });
    expect(written).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it("asr 槽位绑 asr 能力模型 → 绑定成功并写审计", async () => {
    const written: SettingsRow[] = [];
    const audit: unknown[] = [];
    const db = makeDb({
      registryRows: [registry()],
      writtenSettings: written,
      writtenAudit: audit,
    });
    const result = await bindModelSlot(db as never, {
      ...ACTOR,
      slot: "asr",
      modelId: "xingchen-asr",
    });
    expect(result).toEqual({ bound: true });
    expect(audit).toHaveLength(1);
  });

  it("解绑（modelId=null）不做能力校验", async () => {
    const db = makeDb({ registryRows: [] });
    const result = await bindModelSlot(db as never, {
      ...ACTOR,
      slot: "asr",
      modelId: null,
    });
    expect(result).toEqual({ bound: true });
  });
});

describe("resolveSlotChainRuntime 运行时能力兜底", () => {
  it("asr 槽位绑定缺 asr 能力的模型（绕库写入）→ 空链回落 env", async () => {
    const db = makeDb({
      settingsRows: [{ key: "model_slot_asr", value: "deepseekVision" }],
      registryRows: [
        registry({
          modelId: "deepseekVision",
          displayName: "deepseek-v4-flash-vision-exp",
          capabilities: ["text", "vision"],
        }),
      ],
    });
    await expect(resolveSlotChainRuntime(db as never, "asr")).resolves.toEqual(
      [],
    );
  });

  it("asr 槽位绑定 asr 模型 → 正常返回链（含 protocol）", async () => {
    const db = makeDb({
      settingsRows: [{ key: "model_slot_asr", value: "xingchen-asr" }],
      registryRows: [registry()],
    });
    const chain = await resolveSlotChainRuntime(db as never, "asr");
    expect(chain).toHaveLength(1);
    expect(chain[0]?.protocol).toBe("audio_transcriptions");
    expect(chain[0]?.displayName).toBe("XingChenAGI/XingChenASR-V3.2-Ultra");
  });

  it("protocol 缺省/非法值的旧条目回落 chat_inline", async () => {
    const db = makeDb({
      settingsRows: [{ key: "model_slot_asr", value: "legacy-mimo" }],
      registryRows: [
        registry({ modelId: "legacy-mimo", protocol: null }),
      ],
    });
    const chain = await resolveSlotChainRuntime(db as never, "asr");
    expect(chain[0]?.protocol).toBe("chat_inline");
  });
});
