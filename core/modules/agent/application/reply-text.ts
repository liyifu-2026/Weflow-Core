/**
 * 回复文本归一化（纯函数，无数据库依赖）。
 *
 * 重复回复守卫（duplicate-reply）与回复分段校验（policy-gate）需要同一套
 * 归一化口径：两处若各写一份，去重判定就会漂移。
 */

/** 规范化回复文本用于重复比较：去除首尾空白并压缩连续空白 */
export function normalizeReplyText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
