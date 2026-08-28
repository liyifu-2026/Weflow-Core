import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type {
  ConsoleExtensionProjection,
  SolutionsExtensionsResponse,
} from "@weflow-leaif/contracts";
import { api } from "../api";
import { useWeflowAuthStore } from "../auth-store";

/**
 * 设置表单字段是 Console 本地的 UI 概念（当前 Store 投影不携带设置 schema，
 * 预留给 Solution 未来通过契约重新提供）。它不属于 wire DTO，禁止与
 * `@weflow/contracts` 中的投影类型混用。
 */
export type SettingFieldType =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "select"
  | "secret";

export type SettingField = {
  key: string;
  label: string;
  type: SettingFieldType;
  required?: boolean;
  default?: string | number | boolean;
  placeholder?: string;
  options?: Array<{ label: string; value: string }>;
};

/** 按 solution 归组后的扩展视图。 */
export type SolutionExtensionGroup = {
  solutionId: string;
  version: string;
  extensions: ConsoleExtensionProjection[];
};

function groupBySolution(
  projections: ConsoleExtensionProjection[],
): SolutionExtensionGroup[] {
  const groups = new Map<string, SolutionExtensionGroup>();
  for (const projection of projections) {
    let group = groups.get(projection.solutionId);
    if (!group) {
      group = {
        solutionId: projection.solutionId,
        version: projection.version,
        extensions: [],
      };
      groups.set(group.solutionId, group);
    }
    group.extensions.push(projection);
  }
  return [...groups.values()];
}

export const useExtensionStore = defineStore("weflow-extensions", () => {
  // wire DTO 来自 @weflow/contracts 的 ConsoleExtensionProjection；
  // 这里只做归组和导航排序等本地视图派生。
  const solutions = ref<SolutionExtensionGroup[]>([]);
  const loaded = ref(false);
  const loading = ref(false);
  /** 加载失败原因（空串 = 无错误）；ExtensionHost 用它区分「加载失败」与「未找到」。 */
  const loadError = ref("");
  /** 共享中的在途请求；并发调用方等待同一份数据，而不是拿到空列表。 */
  let inflight: Promise<void> | null = null;

  async function load(): Promise<void> {
    if (inflight) return inflight;
    loading.value = true;
    inflight = (async () => {
      try {
        const data = await api<SolutionsExtensionsResponse>(
          "/api/v1/admin/solutions/extensions",
        );
        solutions.value = groupBySolution(data.solutions ?? []);
        loadError.value = "";
      } catch (reason) {
        solutions.value = [];
        loadError.value =
          reason instanceof Error && reason.message
            ? reason.message
            : "扩展清单加载失败";
      } finally {
        loading.value = false;
        loaded.value = true;
      }
    })();
    try {
      await inflight;
    } finally {
      inflight = null;
    }
  }

  const auth = useWeflowAuthStore();

  const navItems = computed(() =>
    solutions.value
      .flatMap((solution) =>
        solution.extensions
          .filter((extension) => !extension.hidden)
          .filter((extension) => !extension.adminOnly || auth.isAdmin)
          .map((extension) => ({
            solutionId: solution.solutionId,
            extension,
            to: `/extensions/${encodeURIComponent(solution.solutionId)}/${encodeURIComponent(extension.extensionId)}`,
          })),
      )
      .sort((a, b) => {
        const group =
          (a.extension.group ?? "").localeCompare(b.extension.group ?? "");
        return group !== 0
          ? group
          : a.extension.path.localeCompare(b.extension.path);
      }),
  );

  function find(solutionId: string, extensionId: string) {
    const solution = solutions.value.find(
      (item) => item.solutionId === solutionId,
    );
    if (!solution) return undefined;
    const extension = solution.extensions.find(
      (item) => item.extensionId === extensionId,
    );
    return extension ? { solution, extension } : undefined;
  }

  return { solutions, loaded, loading, loadError, load, navItems, find };
});

/** 扁平化所有已激活 Solution 的 consoleExtensions 投影。 */
export function flattenProjections(
  groups: readonly SolutionExtensionGroup[],
): ConsoleExtensionProjection[] {
  return groups.flatMap((group) => group.extensions);
}

/**
 * ExtensionHost catch-all 的路径解析：按声明 path 做「最长前缀 + ':param'
 * 单段通配」匹配（如 `/x/:id/detail`）。无命中返回 null，由视图渲染
 * 平台中立的「未找到业务扩展」空态。
 */
export function matchExtension(
  extensions: readonly ConsoleExtensionProjection[],
  currentPath: string,
): ConsoleExtensionProjection | null {
  const actual = currentPath.split("/").filter(Boolean);
  let best: ConsoleExtensionProjection | null = null;
  let bestLength = -1;
  for (const extension of extensions) {
    const pattern = extension.path.split("/").filter(Boolean);
    if (pattern.length !== actual.length) continue;
    if (pattern.length <= bestLength) continue;
    const ok = pattern.every(
      (segment, index) =>
        segment.startsWith(":") || segment === actual[index],
    );
    if (ok) {
      best = extension;
      bestLength = pattern.length;
    }
  }
  return best;
}
