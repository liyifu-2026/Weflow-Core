import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { api } from "../api";

export type ConsoleExtensionNav = {
  group?: string;
  label: string;
  icon?: string;
  order?: number;
};

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

export type SettingCategory = "general" | "integrations" | "security" | "advanced";

export type SettingContribution = {
  id: string;
  category: SettingCategory;
  label: string;
  component?: string;
  order?: number;
  schema?: SettingField[];
};

export type DashboardPosition = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type DashboardContribution = {
  id: string;
  title: string;
  component?: string;
  defaultPosition?: DashboardPosition;
  refreshInterval?: number;
  api?: string;
};

export type PluginApiRoute = {
  prefix: string;
  target: string;
};

export type ConsoleExtension = {
  id: string;
  title: string;
  entry?: string;
  nav?: ConsoleExtensionNav;
  settings?: boolean;
  dashboard?: boolean;
  settingsSchema?: SettingField[];
  settingsContributions?: SettingContribution[];
  dashboardContributions?: DashboardContribution[];
  apiRoutes?: PluginApiRoute[];
  eventSubscriptions?: string[];
};

export type SolutionExtension = {
  solutionId: string;
  version: string;
  extensions: ConsoleExtension[];
};

export const useExtensionStore = defineStore("weflow-extensions", () => {
  const solutions = ref<SolutionExtension[]>([]);
  const loaded = ref(false);
  const loading = ref(false);

  async function load() {
    if (loading.value) return;
    loading.value = true;
    try {
      const data = await api<{ solutions: SolutionExtension[] }>(
        "/api/v1/admin/solutions/extensions",
      );
      solutions.value = data.solutions ?? [];
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
          .filter((extension) => extension.nav && extension.entry)
          .map((extension) => ({
            solutionId: solution.solutionId,
            extension,
            to: `/extensions/${encodeURIComponent(solution.solutionId)}/${encodeURIComponent(extension.id)}`,
          })),
      )
      .sort(
        (a, b) =>
          (a.extension.nav?.order ?? 100) - (b.extension.nav?.order ?? 100),
      ),
  );

  function find(solutionId: string, extensionId: string) {
    const solution = solutions.value.find(
      (item) => item.solutionId === solutionId,
    );
    if (!solution) return undefined;
    const extension = solution.extensions.find(
      (item) => item.id === extensionId,
    );
    return extension ? { solution, extension } : undefined;
  }

  return { solutions, loaded, loading, load, navItems, find };
});
