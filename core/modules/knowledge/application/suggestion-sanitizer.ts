/**
 * 建议回复文本清洗层（最后防线）
 * Prompt/生成合同是第一层约束；此模块只处理展示格式，不改变业务语义：
 * - 剥离 Markdown 符号（标题/加粗/斜体/行内代码/链接/引用/列表/代码块）
 * - 剥离「建议回复：」等常见前缀
 * - 压缩空白与多余空行
 */

/** 剥离常见前缀（"建议回复：" / "建议：" / "回复："） */
function stripPrefix(value: string): string {
  return value.replace(/^\s*(?:建议回复|建议|回复)\s*[:：]\s*/, "");
}

/** 剥离 Markdown 语法符号，保留文字内容 */
function stripMarkdown(value: string): string {
  return (
    value
      // 代码块整体移除
      .replace(/```[\s\S]*?```/g, "")
      // 标题符号
      .replace(/^#{1,6}\s*/gm, "")
      // 加粗/斜体
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      // 行内代码
      .replace(/`([^`]+)`/g, "$1")
      // 链接 [文字](url) → 文字
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      // 引用行
      .replace(/^\s*>\s*/gm, "")
      // 无序列表
      .replace(/^\s*[-*+]\s+/gm, "")
      // 有序列表
      .replace(/^\s*\d+[.、)]\s+/gm, "")
      // 行尾多个空格（markdown 换行）
      .replace(/[ \t]+\n/g, "\n")
  );
}

/** 压缩空白：连续空白/空行合并为单个空格；中文标点后不留空格 */
function collapseWhitespace(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/([：:。，,；;！!？?])\s+/g, "$1")
    .trim();
}

/** 清洗建议回复文本：纯文本、无前缀、无 Markdown 残留 */
export function normalizeSuggestionText(text: string): string {
  if (!text) return text;
  const cleaned = collapseWhitespace(stripMarkdown(stripPrefix(text)));
  // 空行清理后再剥一次前缀（列表剥离可能暴露前缀）
  return stripPrefix(cleaned).trim();
}
