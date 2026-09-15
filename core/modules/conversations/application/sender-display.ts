/**
 * 发送者匿名标识（模型上下文与 API 投影共用的渠道中立格式，ADR-0011）。
 *
 * 未同步到联系人资料的发送者（actorId 为通道联系人 ID）不能把原始 ID
 * 裸露给模型或前端，统一缩写为「contact…尾 6 位」。此前三处各自手写
 * `wx…${id.slice(-6)}`（微信语义泄漏进引擎），现收敛于此。
 */
export function maskedSenderLabel(actorId: string): string {
  return `contact…${actorId.slice(-6)}`;
}
