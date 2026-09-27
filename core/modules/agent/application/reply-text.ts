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

/**
 * 回复批次指纹：按空行拆段、逐段归一化后排序重拼。
 *
 * 整批按序比较拦不住「同几句话换个顺序再说一遍」（2026-09-23 X230 实测：
 * 模型转人工时把上一条回复的两句换序当告别语重发，客户侧同一句话收两遍）。
 * 两侧输入（新回复文本、历史批次 join 产物）经过同一变换，分段内再嵌空行时
 * 两边拆出同样的段集，指纹仍然可比。
 */
export function replyFingerprint(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(normalizeReplyText)
    .filter((segment) => segment.length > 0)
    .sort()
    .join("\n\n");
}
