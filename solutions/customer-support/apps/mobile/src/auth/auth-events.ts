/**
 * 认证事件总线模块
 * 当 API 请求收到 401 响应时，通知所有订阅者执行重新登录流程。
 */
const listeners = new Set<() => void>();

/** 订阅认证失效事件，返回取消订阅函数 */
export function subscribeAuthenticationRequired(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 触发认证失效事件，通知所有订阅者 */
export function notifyAuthenticationRequired(): void {
  listeners.forEach((listener) => listener());
}
