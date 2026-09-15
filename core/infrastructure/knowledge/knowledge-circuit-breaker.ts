/**
 * 知识检索熔断器（L1 反编造层：能力宣传 = 运行时现实）。
 *
 * WeKnora 持续失败时，若提示词仍宣称"知识库检索当前可用"，模型会陷入
 * "看得见可用却调不动"的矛盾——实测后果是基于参数记忆编造"已查询"结论。
 * 本装饰器在连续失败达到阈值后进入 open 态：调用方（agent-worker 装配的
 * knowledgeSearch 闭包）据此从 availableTools 撤下 retrieve_knowledge，
 * 提示词自动切换为"知识库检索当前不可用"；冷却期满放行一次探测（half-open），
 * 成功即闭合恢复，失败重新打开。
 *
 * 计数器是进程内的：agent-worker 是决策检索的唯一消费方，单进程语义足够。
 * 开闭转换只打日志——失败明细由既有 tool_completed 事件（errorCode）承载。
 */
import type { KnowledgeSearch } from "../../modules/knowledge/contracts/knowledge-search.js";

/** 连续失败达到该次数进入 open。 */
const FAILURE_THRESHOLD = 3;
/** open 后的冷却毫秒数；期满进入 half-open 放行一次探测。 */
const COOLDOWN_MS = 60_000;
/** open 态直接抛出的错误码（进入既有工具失败回执路径，不烧 15s 超时）。 */
export const KNOWLEDGE_CIRCUIT_OPEN_ERROR = "knowledge_circuit_open";

/** 结构兼容 pino logger 与 console 的最小 info 形状。 */
type BreakerLogger = { info: (obj: object, msg: string) => void } | undefined;

export type CircuitBreakerKnowledgeSearch = KnowledgeSearch & {
  /** 熔断器是否处于 open 态（含冷却期内的 half-open 起始）。 */
  isOpen: () => boolean;
};

export function createCircuitBreakerKnowledgeSearch(
  inner: KnowledgeSearch,
  logger?: BreakerLogger,
): CircuitBreakerKnowledgeSearch {
  let consecutiveFailures = 0;
  let openedAt = 0;

  const isOpen = (): boolean =>
    openedAt !== 0 && Date.now() - openedAt < COOLDOWN_MS;

  return {
    isOpen,
    async search(input) {
      if (openedAt !== 0) {
        if (isOpen()) {
          throw new Error(KNOWLEDGE_CIRCUIT_OPEN_ERROR);
        }
        // 冷却期满：half-open，放行本次作为探测；成败在下方统一结算。
      }
      try {
        const evidence = await inner.search(input);
        if (openedAt !== 0) {
          logger?.info(
            { consecutiveFailures },
            "knowledge circuit closed after probe success",
          );
        }
        openedAt = 0;
        consecutiveFailures = 0;
        return evidence;
      } catch (error) {
        consecutiveFailures += 1;
        if (openedAt === 0 && consecutiveFailures >= FAILURE_THRESHOLD) {
          openedAt = Date.now();
          logger?.info(
            { consecutiveFailures, reason: errorMessage(error) },
            "knowledge circuit opened after consecutive failures",
          );
        } else if (openedAt !== 0) {
          // half-open 探测失败：重新计时冷却。
          openedAt = Date.now();
          logger?.info(
            { reason: errorMessage(error) },
            "knowledge circuit re-opened after probe failure",
          );
        }
        throw error;
      }
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
