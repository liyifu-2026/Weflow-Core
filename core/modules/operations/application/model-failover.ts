/**
 * 故障转移模型客户端（R2 模型网关运行时）。
 *
 * 实现平台 TextModel 契约：按槽位解析出的模型链依次尝试——主模型
 * 失败/超时自动切下一个；全链失败抛最后一次错误（fail-loud，由既有
 * turn 失败协调器接管降级）。
 *
 * 健康状态：每次调用结果（成功/失败）记录在进程内健康表，供设置页
 * 展示（模型是否可达、最近一次失败时间与原因）。健康状态不持久化——
 * 重启即重置，首个请求重新探测。
 *
 * 组合根（agent-worker）按槽位构建一次 FailoverTextModel；模型注册表
 * 变化经既有 15s 轮询（model-settings-hot 模式）重建链。
 */
import type { TextGenerationRequest } from "../../../modules/model/contracts/text-generation-request.js";
import type { TextGenerationResult } from "../../../modules/model/contracts/text-generation-result.js";
import type { TextModel } from "../../../modules/model/contracts/text-model.js";

/** 链上单个模型条目（组合根从注册表解析后传入） */
export type FailoverLink = {
  /** 注册表 modelId（健康状态表的主键） */
  modelId: string;
  /** 展示名（审计/事件用） */
  displayName: string;
  /** 已构建的 OpenAI 兼容客户端 */
  client: TextModel;
};

export type ModelHealth = {
  modelId: string;
  displayName: string;
  /** 最近一次调用是否成功；从未调用 = null */
  lastSuccess: boolean | null;
  lastFailureReason: string | null;
  lastCheckedAt: number | null;
  /** 累计成功/失败计数（进程生命周期内） */
  successCount: number;
  failureCount: number;
};

/** 进程内健康表：modelId → 状态（跨链共享，模型唯一） */
const healthTable = new Map<string, ModelHealth>();

/** 读取全部模型健康状态（设置页只读展示） */
export function readModelHealth(): ModelHealth[] {
  return [...healthTable.values()].map((entry) => ({ ...entry }));
}

function recordHealth(
  link: FailoverLink,
  success: boolean,
  reason?: string,
): void {
  const existing = healthTable.get(link.modelId) ?? {
    modelId: link.modelId,
    displayName: link.displayName,
    lastSuccess: null,
    lastFailureReason: null,
    lastCheckedAt: null,
    successCount: 0,
    failureCount: 0,
  };
  existing.lastSuccess = success;
  existing.lastCheckedAt = Date.now();
  if (success) {
    existing.successCount += 1;
    existing.lastFailureReason = null;
  } else {
    existing.failureCount += 1;
    existing.lastFailureReason = reason ?? "unknown";
  }
  healthTable.set(link.modelId, existing);
}

/** 测试钩子：清空健康表（vitest 隔离用） */
export function resetModelHealth(): void {
  healthTable.clear();
}

export class FailoverTextModel implements TextModel {
  #links: readonly FailoverLink[];

  constructor(links: readonly FailoverLink[]) {
    if (links.length === 0) {
      throw new Error("failover_chain_empty");
    }
    this.#links = links;
  }

  /** 当前链快照（组合根诊断用） */
  get links(): readonly FailoverLink[] {
    return this.#links;
  }

  async generate(request: TextGenerationRequest): Promise<TextGenerationResult> {
    let lastError: unknown;
    for (const link of this.#links) {
      try {
        const result = await link.client.generate(request);
        recordHealth(link, true);
        return result;
      } catch (error) {
        lastError = error;
        recordHealth(
          link,
          false,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("failover_chain_exhausted");
  }
}
