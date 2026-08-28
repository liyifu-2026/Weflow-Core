/**
 * 验证检索计数（本地）：Core 不为透传的 /knowledge-search 记审计，
 * 这里只在浏览器侧累计本控制台的验证检索次数，用于知识概览展示。
 */
const STORAGE_KEY = "wf.knowledge.validate-search-count";

export function getValidateSearchCount(): number {
  try {
    const raw = Number(globalThis.localStorage?.getItem(STORAGE_KEY) ?? 0);
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  } catch {
    return 0;
  }
}

export function recordValidateSearch(): number {
  const next = getValidateSearchCount() + 1;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(next));
  } catch {
    // 存储不可用时静默降级，计数仅本次会话有效。
  }
  return next;
}
