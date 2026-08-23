<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  useExtensionStore,
  type SettingCategory,
  type SettingContribution,
} from "../stores/extensions";
import WfIcon from "../components/WfIcon.vue";
import SettingForm from "../components/SettingForm.vue";
import PageHeader from "../components/PageHeader.vue";
import EmptyState from "../components/EmptyState.vue";

const extensions = useExtensionStore();

const activeCategory = ref<SettingCategory>("");
const searchQuery = ref("");

type PluginSetting = {
  solutionId: string;
  version: string;
  extensionId: string;
  contributionId: string;
  category: SettingCategory;
  categoryLabel?: string;
  label: string;
  order: number;
  component?: string;
  schema?: SettingContribution["schema"];
};

const pluginSettings = computed<PluginSetting[]>(() =>
  extensions.solutions.flatMap((solution) =>
    solution.extensions.flatMap((extension) => {
      const contributions = extension.settingsContributions?.length
        ? extension.settingsContributions
        : extension.settingsSchema
          ? [
              {
                id: extension.id,
                category: "general",
                categoryLabel: "通用",
                label: extension.title,
                order: 100,
                schema: extension.settingsSchema,
              },
            ]
          : [];
      return contributions.map((contribution) => ({
        solutionId: solution.solutionId,
        version: solution.version,
        extensionId: extension.id,
        contributionId: contribution.id,
        category: contribution.category,
        categoryLabel: contribution.categoryLabel,
        label: contribution.label,
        order: contribution.order ?? 100,
        component: contribution.component,
        schema: contribution.schema,
      }));
    }),
  ),
);

const normalizedQuery = computed(() => searchQuery.value.trim().toLowerCase());
const filteredPluginSettings = computed(() => {
  const q = normalizedQuery.value;
  if (!q) return pluginSettings.value;
  return pluginSettings.value.filter((item) =>
    `${item.label} ${item.solutionId} ${item.categoryLabel ?? ""} ${item.category}`
      .toLowerCase()
      .includes(q),
  );
});

const CATEGORY_LABELS: Record<string, string> = {
  general: "通用",
  security: "安全",
  integrations: "集成",
  integration: "集成",
  external: "外部服务",
  advanced: "高级",
};

const categories = computed(() => {
  const map = new Map<string, string>();
  for (const item of filteredPluginSettings.value) {
    const fallback = item.category === "general" ? "通用" : item.category;
    const label = CATEGORY_LABELS[item.category] || item.categoryLabel || fallback;
    if (!map.has(item.category)) {
      map.set(item.category, label);
    }
  }
  return Array.from(map.entries()).map(([key, label]) => ({ key, label }));
});

const effectiveCategory = computed(() => {
  if (categories.value.some((item) => item.key === activeCategory.value)) {
    return activeCategory.value;
  }
  return categories.value[0]?.key ?? "";
});

const activeCategoryLabel = computed(
  () =>
    categories.value.find((item) => item.key === effectiveCategory.value)
      ?.label ?? "设置项",
);

const activePluginSettings = computed(() =>
  filteredPluginSettings.value
    .filter((item) => item.category === effectiveCategory.value)
    .sort((a, b) => a.order - b.order),
);

onMounted(() => {
  if (!extensions.loaded) void extensions.load();
});
</script>

<template>
  <div class="wf-page wf-settings-page">
    <PageHeader title="统一设置" />

    <nav
      v-if="categories.length > 1"
      class="wf-settings-tabs"
      aria-label="设置分类"
    >
      <button
        v-for="category in categories"
        :key="category.key"
        class="wf-settings-tab"
        :class="{ active: effectiveCategory === category.key }"
        @click="activeCategory = category.key"
      >
        {{ category.label }}
      </button>
    </nav>

    <section class="wf-panel">
      <div class="wf-panel-head">
        <h2>{{ activeCategoryLabel }}</h2>
        <span class="wf-muted">{{ activePluginSettings.length }} 项</span>
      </div>

      <div v-if="!extensions.loaded" class="wf-panel-body">
        <span class="wf-skeleton">正在加载设置…</span>
      </div>

      <div v-else class="wf-setting-list">
        <article
          v-for="item in activePluginSettings"
          :key="`${item.solutionId}:${item.extensionId}:${item.contributionId}`"
          class="wf-setting-row wf-setting-row-plugin"
        >
          <div class="wf-setting-plugin-head">
            <span class="wf-setting-plugin-icon">
              <WfIcon name="engine" :size="17" />
            </span>
            <div>
              <strong>{{ item.label }}</strong>
              <span>{{ item.solutionId }} · v{{ item.version }}</span>
            </div>
          </div>
          <SettingForm
            v-if="item.schema?.length"
            :solution-id="item.solutionId"
            :extension-id="item.extensionId"
            :schema="item.schema"
          />
          <p v-else-if="item.component" class="wf-muted">
            远程设置组件待接入：{{ item.component }}
          </p>
        </article>

        <EmptyState
          v-if="activePluginSettings.length === 0"
          :title="
            normalizedQuery
              ? '没有匹配的设置项'
              : pluginSettings.length === 0
                ? '暂无设置项'
                : '该分类暂无设置项'
          "
          :description="
            normalizedQuery
              ? '换个关键词试试。'
              : pluginSettings.length === 0
                ? '安装业务包后，其设置会自动出现在这里。'
                : '当前分类没有设置项。'
          "
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.wf-settings-page {
  max-width: 960px;
}
.wf-settings-search {
  margin-bottom: 14px;
}
.wf-settings-tabs {
  display: flex;
  gap: 6px;
  margin: 0 0 14px;
  flex-wrap: wrap;
}
.wf-settings-tab {
  padding: 7px 14px;
  border: 1px solid var(--wf-border);
  border-radius: 999px;
  background: var(--wf-surface);
  color: var(--wf-text-secondary);
  font-weight: 600;
  cursor: pointer;
  transition:
    background var(--wf-motion-fast) var(--wf-ease-out),
    color var(--wf-motion-fast) var(--wf-ease-out),
    border-color var(--wf-motion-fast) var(--wf-ease-out);
}
.wf-settings-tab:hover {
  border-color: var(--wf-border-strong);
  color: var(--wf-text);
}
.wf-settings-tab.active {
  background: var(--wf-primary-soft);
  border-color: color-mix(in srgb, var(--wf-primary) 35%, transparent);
  color: var(--wf-primary);
}
.wf-setting-list {
  padding: 4px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.wf-setting-row {
  border: 1px solid var(--wf-border);
  border-radius: 10px;
  background: var(--wf-surface-elevated);
}
.wf-setting-row-plugin {
  overflow: hidden;
}
.wf-setting-plugin-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--wf-border);
  background: var(--wf-surface-soft);
}
.wf-setting-plugin-icon {
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: var(--wf-primary-soft);
  color: var(--wf-primary);
}
.wf-setting-plugin-head strong {
  display: block;
  margin-bottom: 2px;
  font-size: 14px;
}
.wf-setting-plugin-head span {
  color: var(--wf-text-secondary);
  font-size: 12px;
}
</style>
