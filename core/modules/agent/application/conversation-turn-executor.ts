/**
 * 会话轮次串行执行器
 *
 * 确保同一会话（conversationId）的任务按顺序串行执行，
 * 不同会话之间可以并行。使用 Promise 链实现队列化。
 */

export class ConversationTurnExecutor {
  /** 每个会话的 Promise 尾部指针，用于串联任务 */
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * 在指定会话的串行队列中执行任务
   * 同一会话的任务会等待前一个任务完成后才开始
   */
  async run<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(conversationId) ?? Promise.resolve();
    const ready = previous.catch(() => undefined); // 忽略前序任务的错误，不影响后续执行
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = ready.then(() => gate);
    this.tails.set(conversationId, tail);

    await ready; // 等待前序任务完成
    try {
      return await task();
    } finally {
      release(); // 释放后续任务
      // 清理已完成的尾部指针（防止内存泄漏）
      if (this.tails.get(conversationId) === tail) {
        this.tails.delete(conversationId);
      }
    }
  }
}
