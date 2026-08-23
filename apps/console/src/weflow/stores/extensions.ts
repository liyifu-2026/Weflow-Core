import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type {
  ConsoleExtensionProjection,
  SolutionsExtensionsResponse,
} from "@weflow/contracts";
import { api } from "../api";

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

  async function load() {
    if (loading.value) return;
    loading.value = true;
    try {
      const data = await api<SolutionsExtensionsResponse>(
        "/api/v1/admin/solutions/extensions",
      );
      solutions.value = groupBySolution(data.solutions ?? []);
    } catch {
      solutions.value = [];
    } finally {
      loaded.value = true;
      loading.value = false;
    }
  }

  const navItems = computed(() =>
    solutions.value
      .flatMap((solution) =>
        solution.extensions
          .filter((extension) => !extension.hidden)
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

  return { solutions, loaded, loading, load, navItems, find };
});
