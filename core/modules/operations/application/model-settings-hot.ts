/**
 * 平台模型设置热加载（Hot Reload）应用层。
 *
 * 背景：model-settings.ts 的写路径（updateModelSettings）由 Console
 * 「平台大模型」表单调用；消费方（agent-worker）过去在启动时读取一次，
 * 改 baseUrl / apiKey / 槽位模型名需重启 worker 才生效。
 *
 * 热加载机制（跨进程安全）：
 * - 组合根（agent-worker）启动时照旧读取一次配置完成初始装配；
 * - 随后调用 startModelSettingsReloader 以该配置为种子：
 *   同进程写路径 notifyModelSettingsChanged → 立即重读 DB，
 *   与上次快照逐字段比较，只有内容变化才回调 apply（替换客户端）；
 * - 每 intervalMs（默认 15s）轮询重读一次 DB 兜底跨进程传播
 *   （PATCH 落在 API 进程、消费在 worker 进程时，延迟上界 = 轮询间隔）；
 * - 读失败保持旧快照继续服务，下个周期重试（fail-safe）。
 *
 * "何时失效"由本模块负责，"读什么"仍是 model-settings.readModelSettingsRuntime。
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import {
  readModelSettingsRuntime,
  type ModelSettingsDefaults,
  type ModelSettingsRuntime,
} from "./model-settings.js";

type Database = NodePgDatabase<typeof schema>;

const listeners = new Set<() => void>();

/**
 * 写路径调用：模型设置已成功持久化，通知同进程订阅者立即重读。
 * （跨进程场景由消费方的 DB 轮询兜底。）
 */
export function notifyModelSettingsChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 订阅者异常不阻断写路径；轮询兜底会最终收敛。
    }
  }
}

/** 订阅模型设置变更；返回取消订阅函数。 */
export function subscribeModelSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 快照是否与上一次完全一致（逐字段比较；apiKey 只参与比较、不落日志）。 */
function sameSettings(
  a: ModelSettingsRuntime,
  b: ModelSettingsRuntime,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 启动模型设置热加载循环。
 * @param seed 组合根启动装配时读取的配置（作为首个比较基线）
 * @param apply 快照变化时调用（组合根原子替换 LLM 客户端）
 * 返回停止函数（清理定时器与订阅）。
 */
export function startModelSettingsReloader(
  db: Database,
  defaults: ModelSettingsDefaults,
  seed: ModelSettingsRuntime,
  apply: (settings: ModelSettingsRuntime) => void,
  intervalMs = 15_000,
): () => void {
  let last: ModelSettingsRuntime = seed;
  let loading = false;
  let stopped = false;

  const reload = async (): Promise<void> => {
    if (stopped || loading) return;
    loading = true;
    try {
      const next = await readModelSettingsRuntime(db, defaults);
      if (sameSettings(last, next)) return;
      last = next;
      apply(next);
    } catch {
      // 读失败保持旧快照继续服务；下个周期重试。
    } finally {
      loading = false;
    }
  };

  const unsubscribe = subscribeModelSettings(() => {
    void reload();
  });
  const timer = setInterval(() => {
    void reload();
  }, intervalMs);

  return () => {
    stopped = true;
    unsubscribe();
    clearInterval(timer);
  };
}
