/**
 * 接待编排（Reception Plan）纯函数：扩展设置提取 + 关键词路由匹配。
 *
 * 运行时优先级（在 index.ts 的 resolveAiEmployeePrompt 中编排）：
 *   1. 联系人显式绑定
 *   2. 本模块的关键词路由（触发文本 → employeeKey）
 *   3. 工作区默认员工
 *
 * 兜底原则：配置缺失 / 类型不符 / 匹配失败一律 fail-open 到下一优先级，
 * 绝不因编排配置异常阻断消息处理。
 */

/** 关键词 → 员工 路由（自上而下第一条命中生效） */
export type EmployeeRoute = {
  keywords: string[];
  employeeKey: string;
};

/** 接待编排在扩展设置里的投影（只取运行时需要的字段） */
export type ReceptionPlan = {
  defaultEmployeeKey: string | null;
  employeeRoutes: EmployeeRoute[];
};

export const EMPTY_RECEPTION_PLAN: ReceptionPlan = {
  defaultEmployeeKey: null,
  employeeRoutes: [],
};

/**
 * 从扩展设置的原始 JSON 容错提取接待编排路由。
 * 期望形状：{ pipeline: { defaultEmployeeKey, employeeRoutes: [{keywords, employeeKey}] } }
 * 缺字段 / 类型不符 / 空值逐项回落，空关键词与空员工键的路由整条丢弃。
 */
export function extractReceptionPlan(raw: unknown): ReceptionPlan {
  if (typeof raw !== "object" || raw === null) return EMPTY_RECEPTION_PLAN;
  const pipeline = (raw as Record<string, unknown>).pipeline;
  if (typeof pipeline !== "object" || pipeline === null) {
    return EMPTY_RECEPTION_PLAN;
  }
  const source = pipeline as Record<string, unknown>;
  const defaultEmployeeKey =
    typeof source.defaultEmployeeKey === "string" &&
    source.defaultEmployeeKey.trim() !== ""
      ? source.defaultEmployeeKey
      : null;
  const employeeRoutes = Array.isArray(source.employeeRoutes)
    ? source.employeeRoutes.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const route = item as Record<string, unknown>;
        const employeeKey =
          typeof route.employeeKey === "string" ? route.employeeKey.trim() : "";
        const keywords = Array.isArray(route.keywords)
          ? route.keywords.filter(
              (word): word is string =>
                typeof word === "string" && word.trim() !== "",
            )
          : [];
        if (employeeKey === "" || keywords.length === 0) return [];
        return [{ employeeKey, keywords }];
      })
    : [];
  return { defaultEmployeeKey, employeeRoutes };
}

/** 关键词子串匹配（大小写不敏感）；返回命中的 employeeKey 或 null */
export function matchEmployeeRoute(
  triggerText: string,
  routes: readonly EmployeeRoute[],
): string | null {
  const normalized = triggerText.toLowerCase();
  if (normalized === "") return null;
  for (const route of routes) {
    const hit = route.keywords.find((keyword) => {
      const needle = keyword.toLowerCase();
      return needle !== "" && normalized.includes(needle);
    });
    if (hit) return route.employeeKey;
  }
  return null;
}
