/**
 * 平台大模型设置（Operator Control Plane）
 *
 * 让管理员通过 Console 设置页配置文本/视觉模型（baseUrl / API key / 模型名），
 * 业务 Solution（如客服）通过 runtime-settings 的模型选择直接消费平台模型。
 *
 * 存储：operations.runtime_settings 表（key = model_* / vision_*）。
 * - API key 属于 secret：读取时永不回显，只暴露 hasApiKey 标志；
 *   写入时传空串/缺省表示保持原值。
 * - 所有修改写 audit.events（previous/next + operationId 分组）。
 * - 消费方（agent-worker）启动时读取一次；修改后需重启 worker 生效。
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

/** 服务端允许的模型注册表（与 runtime-settings 保持一致） */
export const MODEL_NAME_ALLOWLIST = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
] as const;

export const VISION_MODEL_NAME_ALLOWLIST = ["mimo-v2.5"] as const;

/** 环境默认值（config 传入，作为 DB 缺失时的 fallback） */
export type ModelSettingsDefaults = {
  textModel: { name: string; baseUrl: string; apiKey?: string };
  visionModel: { name: string; baseUrl: string; apiKey?: string };
  asrModel: { name: string; baseUrl: string; apiKey?: string };
  triageModel?: { name: string; baseUrl: string; apiKey?: string };
  fastModel?: { name: string; baseUrl: string; apiKey?: string };
};

/** 对外暴露的模型设置视图（apiKey 永不回显） */
export type ModelSettingsView = {
  textModel: {
    name: string;
    baseUrl: string;
    hasApiKey: boolean;
  };
  visionModel: {
    name: string;
    baseUrl: string;
    hasApiKey: boolean;
  };
  asrModel: {
    name: string;
    baseUrl: string;
    hasApiKey: boolean;
  };
  triageModel?: {
    name: string;
    baseUrl: string;
    hasApiKey: boolean;
  };
  fastModel?: {
    name: string;
    baseUrl: string;
    hasApiKey: boolean;
  };
};

/** 可写入的模型设置补丁 */
export type ModelSettingsPatch = {
  textModel?: {
    name?: (typeof MODEL_NAME_ALLOWLIST)[number];
    baseUrl?: string;
    /** 空串/缺省 = 保持原值 */
    apiKey?: string;
  };
  visionModel?: {
    name?: (typeof VISION_MODEL_NAME_ALLOWLIST)[number];
    baseUrl?: string;
    apiKey?: string;
  };
  asrModel?: {
    /** 语音转写模型名（专用 ASR 端点，如 XingChenAGI/XingChenASR-V3.2-Ultra） */
    name?: string;
    baseUrl?: string;
    apiKey?: string;
  };
  /** 预判分流模型槽位（供应商自由命名，如 Qwen/Qwen2.5-7B-Instruct） */
  triageModel?: {
    name?: string;
    baseUrl?: string;
    /** 空串/缺省 = 保持原值 */
    apiKey?: string;
  };
  /** 直答模型槽位（供应商自由命名，如 THUDM/GLM-4-9B-0414） */
  fastModel?: {
    name?: string;
    baseUrl?: string;
    /** 空串/缺省 = 保持原值 */
    apiKey?: string;
  };
};

type FieldKeys = {
  name: string;
  baseUrl: string;
  apiKey: string;
};

const TEXT_KEYS: FieldKeys = {
  name: "model_name",
  baseUrl: "model_base_url",
  apiKey: "model_api_key",
};

const VISION_KEYS: FieldKeys = {
  name: "vision_model",
  baseUrl: "vision_base_url",
  apiKey: "vision_api_key",
};

const ASR_KEYS: FieldKeys = {
  name: "asr_model",
  baseUrl: "asr_base_url",
  apiKey: "asr_api_key",
};

const TRIAGE_KEYS: FieldKeys = {
  name: "triage_model",
  baseUrl: "triage_base_url",
  apiKey: "triage_api_key",
};

const FAST_KEYS: FieldKeys = {
  name: "fast_model",
  baseUrl: "fast_base_url",
  apiKey: "fast_api_key",
};

async function readRow(
  db: NodePgDatabase<typeof schema>,
  key: string,
): Promise<string | undefined> {
  const rows = await db
    .select({ value: schema.runtimeSettings.value })
    .from(schema.runtimeSettings)
    .where(eq(schema.runtimeSettings.key, key))
    .limit(1);
  return rows[0]?.value;
}

/** 运行时完整配置（服务端消费方使用：含 apiKey，不得对外返回） */
export type ModelSettingsRuntime = {
  textModel: { name: string; baseUrl: string; apiKey?: string };
  visionModel: { name: string; baseUrl: string; apiKey?: string };
  asrModel: { name: string; baseUrl: string; apiKey?: string };
  triageModel?: { name: string; baseUrl: string; apiKey?: string };
  fastModel?: { name: string; baseUrl: string; apiKey?: string };
};

/**
 * 读取模型设置完整配置（供 agent-worker 等消费方启动时使用）。
 * DB 覆盖 env 默认值；apiKey 仅在 DB 或 env 有值时存在。
 */
export async function readModelSettingsRuntime(
  db: NodePgDatabase<typeof schema>,
  defaults: ModelSettingsDefaults,
): Promise<ModelSettingsRuntime> {
  const textName =
    (await readRow(db, TEXT_KEYS.name)) ?? defaults.textModel.name;
  const textBaseUrl =
    (await readRow(db, TEXT_KEYS.baseUrl)) ?? defaults.textModel.baseUrl;
  const textApiKey = await readRow(db, TEXT_KEYS.apiKey);
  const visionName =
    (await readRow(db, VISION_KEYS.name)) ?? defaults.visionModel.name;
  const visionBaseUrl =
    (await readRow(db, VISION_KEYS.baseUrl)) ?? defaults.visionModel.baseUrl;
  const visionApiKey = await readRow(db, VISION_KEYS.apiKey);
  const asrName = (await readRow(db, ASR_KEYS.name)) ?? defaults.asrModel.name;
  const asrBaseUrl =
    (await readRow(db, ASR_KEYS.baseUrl)) ?? defaults.asrModel.baseUrl;
  const asrApiKey = await readRow(db, ASR_KEYS.apiKey);
  const triageDefaults = defaults.triageModel;
  const triageName = triageDefaults
    ? ((await readRow(db, TRIAGE_KEYS.name)) ?? triageDefaults.name)
    : await readRow(db, TRIAGE_KEYS.name);
  const triageBaseUrl = triageDefaults
    ? ((await readRow(db, TRIAGE_KEYS.baseUrl)) ?? triageDefaults.baseUrl)
    : await readRow(db, TRIAGE_KEYS.baseUrl);
  const triageApiKey = await readRow(db, TRIAGE_KEYS.apiKey);
  const fastDefaults = defaults.fastModel;
  const fastName = fastDefaults
    ? ((await readRow(db, FAST_KEYS.name)) ?? fastDefaults.name)
    : await readRow(db, FAST_KEYS.name);
  const fastBaseUrl = fastDefaults
    ? ((await readRow(db, FAST_KEYS.baseUrl)) ?? fastDefaults.baseUrl)
    : await readRow(db, FAST_KEYS.baseUrl);
  const fastApiKey = await readRow(db, FAST_KEYS.apiKey);
  return {
    textModel: {
      name: textName,
      baseUrl: textBaseUrl,
      ...(textApiKey !== undefined
        ? { apiKey: textApiKey }
        : defaults.textModel.apiKey !== undefined
          ? { apiKey: defaults.textModel.apiKey }
          : {}),
    },
    visionModel: {
      name: visionName,
      baseUrl: visionBaseUrl,
      ...(visionApiKey !== undefined
        ? { apiKey: visionApiKey }
        : defaults.visionModel.apiKey !== undefined
          ? { apiKey: defaults.visionModel.apiKey }
          : {}),
    },
    asrModel: {
      name: asrName,
      baseUrl: asrBaseUrl,
      ...(asrApiKey !== undefined
        ? { apiKey: asrApiKey }
        : defaults.asrModel.apiKey !== undefined
          ? { apiKey: defaults.asrModel.apiKey }
          : {}),
    },
    ...(triageDefaults && triageName && triageBaseUrl
      ? {
          triageModel: {
            name: triageName,
            baseUrl: triageBaseUrl,
            ...(triageApiKey !== undefined
              ? { apiKey: triageApiKey }
              : triageDefaults.apiKey !== undefined
                ? { apiKey: triageDefaults.apiKey }
                : {}),
          },
        }
      : {}),
    ...(fastDefaults && fastName && fastBaseUrl
      ? {
          fastModel: {
            name: fastName,
            baseUrl: fastBaseUrl,
            ...(fastApiKey !== undefined
              ? { apiKey: fastApiKey }
              : fastDefaults.apiKey !== undefined
                ? { apiKey: fastDefaults.apiKey }
                : {}),
          },
        }
      : {}),
  };
}

/** 读取模型设置：DB 优先，缺失回退环境默认值；apiKey 只返回是否已配置 */
export async function readModelSettings(
  db: NodePgDatabase<typeof schema>,
  defaults: ModelSettingsDefaults,
): Promise<ModelSettingsView> {
  const textName = (await readRow(db, TEXT_KEYS.name)) ?? defaults.textModel.name;
  const textBaseUrl =
    (await readRow(db, TEXT_KEYS.baseUrl)) ?? defaults.textModel.baseUrl;
  const textKey = await readRow(db, TEXT_KEYS.apiKey);
  const visionName =
    (await readRow(db, VISION_KEYS.name)) ?? defaults.visionModel.name;
  const visionBaseUrl =
    (await readRow(db, VISION_KEYS.baseUrl)) ?? defaults.visionModel.baseUrl;
  const visionKey = await readRow(db, VISION_KEYS.apiKey);
  const asrName = (await readRow(db, ASR_KEYS.name)) ?? defaults.asrModel.name;
  const asrBaseUrl =
    (await readRow(db, ASR_KEYS.baseUrl)) ?? defaults.asrModel.baseUrl;
  const asrKey = await readRow(db, ASR_KEYS.apiKey);
  const triageDefaults = defaults.triageModel;
  const triageViewName = triageDefaults
    ? ((await readRow(db, TRIAGE_KEYS.name)) ?? triageDefaults.name)
    : await readRow(db, TRIAGE_KEYS.name);
  const triageViewBaseUrl = triageDefaults
    ? ((await readRow(db, TRIAGE_KEYS.baseUrl)) ?? triageDefaults.baseUrl)
    : await readRow(db, TRIAGE_KEYS.baseUrl);
  const triageViewKey = await readRow(db, TRIAGE_KEYS.apiKey);
  const fastDefaults = defaults.fastModel;
  const fastViewName = fastDefaults
    ? ((await readRow(db, FAST_KEYS.name)) ?? fastDefaults.name)
    : await readRow(db, FAST_KEYS.name);
  const fastViewBaseUrl = fastDefaults
    ? ((await readRow(db, FAST_KEYS.baseUrl)) ?? fastDefaults.baseUrl)
    : await readRow(db, FAST_KEYS.baseUrl);
  const fastViewKey = await readRow(db, FAST_KEYS.apiKey);
  return {
    textModel: {
      name: textName,
      baseUrl: textBaseUrl,
      hasApiKey: Boolean(textKey ?? defaults.textModel.apiKey),
    },
    visionModel: {
      name: visionName,
      baseUrl: visionBaseUrl,
      hasApiKey: Boolean(visionKey ?? defaults.visionModel.apiKey),
    },
    asrModel: {
      name: asrName,
      baseUrl: asrBaseUrl,
      hasApiKey: Boolean(asrKey ?? defaults.asrModel.apiKey),
    },
    ...(triageDefaults && triageViewName && triageViewBaseUrl
      ? {
          triageModel: {
            name: triageViewName,
            baseUrl: triageViewBaseUrl,
            hasApiKey: Boolean(triageViewKey ?? triageDefaults.apiKey),
          },
        }
      : {}),
    ...(fastDefaults && fastViewName && fastViewBaseUrl
      ? {
          fastModel: {
            name: fastViewName,
            baseUrl: fastViewBaseUrl,
            hasApiKey: Boolean(fastViewKey ?? fastDefaults.apiKey),
          },
        }
      : {}),
  };
}

/** 写入模型设置（写审计；apiKey 空/缺省保持原值） */
export async function updateModelSettings(
  db: NodePgDatabase<typeof schema>,
  input: {
    actorUserId: string;
    sourceIp: string;
    patch: ModelSettingsPatch;
    defaults: ModelSettingsDefaults;
  },
): Promise<{ settings: ModelSettingsView; changedKeys: string[] }> {
  const { actorUserId, sourceIp, patch, defaults } = input;
  const operationId = randomUUID();
  const changedKeys: string[] = [];

  await db.transaction(async (transaction) => {
    const current = await readModelSettings(transaction, defaults);
    const candidates: Array<{
      key: string;
      label: string;
      previous: string;
      next: string | undefined;
    }> = [];

    const text = patch.textModel ?? {};
    if (text.name !== undefined) {
      candidates.push({
        key: TEXT_KEYS.name,
        label: "textModel.name",
        previous: current.textModel.name,
        next: text.name,
      });
    }
    if (text.baseUrl !== undefined) {
      candidates.push({
        key: TEXT_KEYS.baseUrl,
        label: "textModel.baseUrl",
        previous: current.textModel.baseUrl,
        next: text.baseUrl.trim().replace(/\/$/, ""),
      });
    }
    if (text.apiKey !== undefined && text.apiKey.trim() !== "") {
      candidates.push({
        key: TEXT_KEYS.apiKey,
        label: "textModel.apiKey",
        previous: current.textModel.hasApiKey ? "(set)" : "(unset)",
        next: "(set)",
      });
    }

    const vision = patch.visionModel ?? {};
    if (vision.name !== undefined) {
      candidates.push({
        key: VISION_KEYS.name,
        label: "visionModel.name",
        previous: current.visionModel.name,
        next: vision.name,
      });
    }
    if (vision.baseUrl !== undefined) {
      candidates.push({
        key: VISION_KEYS.baseUrl,
        label: "visionModel.baseUrl",
        previous: current.visionModel.baseUrl,
        next: vision.baseUrl.trim().replace(/\/$/, ""),
      });
    }
    if (vision.apiKey !== undefined && vision.apiKey.trim() !== "") {
      candidates.push({
        key: VISION_KEYS.apiKey,
        label: "visionModel.apiKey",
        previous: current.visionModel.hasApiKey ? "(set)" : "(unset)",
        next: "(set)",
      });
    }

    const asr = patch.asrModel ?? {};
    if (asr.name !== undefined) {
      candidates.push({
        key: ASR_KEYS.name,
        label: "asrModel.name",
        previous: current.asrModel.name,
        next: asr.name,
      });
    }
    if (asr.baseUrl !== undefined) {
      candidates.push({
        key: ASR_KEYS.baseUrl,
        label: "asrModel.baseUrl",
        previous: current.asrModel.baseUrl,
        next: asr.baseUrl.trim().replace(/\/$/, ""),
      });
    }
    if (asr.apiKey !== undefined && asr.apiKey.trim() !== "") {
      candidates.push({
        key: ASR_KEYS.apiKey,
        label: "asrModel.apiKey",
        previous: current.asrModel.hasApiKey ? "(set)" : "(unset)",
        next: "(set)",
      });
    }

    for (const [slotKeys, slotLabel, slotPatch] of [
      [TRIAGE_KEYS, "triageModel", patch.triageModel] as const,
      [FAST_KEYS, "fastModel", patch.fastModel] as const,
    ]) {
      const viewSlot =
        slotLabel === "triageModel" ? current.triageModel : current.fastModel;
      if (!slotPatch) continue;
      if (slotPatch.name !== undefined) {
        candidates.push({
          key: slotKeys.name,
          label: `${slotLabel}.name`,
          previous: viewSlot?.name ?? "(unset)",
          next: slotPatch.name,
        });
      }
      if (slotPatch.baseUrl !== undefined) {
        candidates.push({
          key: slotKeys.baseUrl,
          label: `${slotLabel}.baseUrl`,
          previous: viewSlot?.baseUrl ?? "(unset)",
          next: slotPatch.baseUrl.trim().replace(/\/$/, ""),
        });
      }
      if (slotPatch.apiKey !== undefined && slotPatch.apiKey.trim() !== "") {
        candidates.push({
          key: slotKeys.apiKey,
          label: `${slotLabel}.apiKey`,
          previous: viewSlot?.hasApiKey ? "(set)" : "(unset)",
          next: "(set)",
        });
      }
    }

    for (const candidate of candidates) {
      if (candidate.next === undefined || candidate.next === candidate.previous) {
        continue;
      }
      await transaction
        .insert(schema.runtimeSettings)
        .values({
          key: candidate.key,
          value: candidate.next,
          updatedBy: actorUserId,
        })
        .onConflictDoUpdate({
          target: schema.runtimeSettings.key,
          set: {
            value: candidate.next,
            updatedBy: actorUserId,
            updatedAt: new Date(),
          },
        });
      await transaction.insert(schema.auditEvents).values({
        auditId: randomUUID(),
        actorUserId,
        eventType: "operator.model_settings_updated",
        subjectType: "model_settings",
        subjectId: candidate.key,
        sourceIp,
        metadata: {
          operationId,
          key: candidate.key,
          previousValue: candidate.previous,
          nextValue: candidate.next,
        },
      });
      changedKeys.push(candidate.label);
    }
  });

  return {
    settings: await readModelSettings(db, defaults),
    changedKeys,
  };
}
