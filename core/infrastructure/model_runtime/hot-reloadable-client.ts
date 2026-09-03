/**
 * 可热更新（Hot-Reloadable）的 OpenAI 兼容模型客户端。
 *
 * 平台模型设置（Operator Control Plane 的 model-settings）保存后要求即时生效、
 * 无需重启 worker。本包装持有当前生效的 OpenAiCompatibleClient 快照，并提供
 * `swap` 原子在调用间隙替换实例：
 * - swap 与 complete 竞争时各自看到旧或新快照，均可用，不存在半初始化状态；
 * - 快照替换后旧 client 由 GC 回收；已在飞行中的请求继续使用旧实例完成；
 * - 未 swap 前使用构造时提供的初始 client（env 默认值）。
 *
 * 热更新信号链路：Console 保存模型设置 → model-settings 应用层写入 DB 并
 * 广播 notifyModelSettingsChanged → agent-worker 订阅者读取最新快照 → swap。
 */
import type { TextGenerationRequest } from "../../modules/model/contracts/text-generation-request.js";
import type { TextGenerationResult } from "../../modules/model/contracts/text-generation-result.js";
import type { TextModel } from "../../modules/model/contracts/text-model.js";
import type { OpenAiCompatibleClient } from "./openai-compatible-client.js";

export class HotReloadableClient implements TextModel {
  #current: OpenAiCompatibleClient;
  readonly #onSwap: ((next: OpenAiCompatibleClient) => void) | undefined;

  constructor(
    initial: OpenAiCompatibleClient,
    onSwap?: (next: OpenAiCompatibleClient) => void,
  ) {
    this.#current = initial;
    this.#onSwap = onSwap;
  }

  /** 原子替换当前 client 快照；并发中的 complete 各自使用替换前后的实例。 */
  swap(next: OpenAiCompatibleClient): void {
    this.#current = next;
    this.#onSwap?.(next);
  }

  /** 当前生效的 client 快照（供组合根在装配下游包装时读取初始值）。 */
  get current(): OpenAiCompatibleClient {
    return this.#current;
  }

  async generate(
    request: TextGenerationRequest,
  ): Promise<TextGenerationResult> {
    return this.#current.generate(request);
  }
}
