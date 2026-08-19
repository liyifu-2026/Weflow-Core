<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  useExtensionStore,
  type SettingCategory,
  type SettingContribution,
} from "../stores/extensions";
import WfIcon from "../components/WfIcon.vue";
import SettingForm from "../components/SettingForm.vue";

const extensions = useExtensionStore();

const categories: Array<{ key: SettingCategory; label: string }> = [
  { key: "general", label: "通用" },
  { key: "integrations", label: "集成" },
  { key: "security", label: "安全" },
  { key: "advanced", label: "高级" },
];

const activeCategory = ref<SettingCategory>("general");

type NativeSetting = {
  title: string;
  description: string;
  to: string;
  icon: string;
};

const nativeSettings: Record<SettingCategory, NativeSetting[]> = {
  general: [
    {
      title: "运行设置",
      description: "Agent 开关、自动回复、能力开关、模型选择、配置回滚",
      to: "/system/operations",
      icon: "engine",
    },
  ],
  integrations: [
    {
      title: "系统状态",
      description: "查看平台基础设施配置与健康",
      to: "/system/status",
      icon: "runtime",
    },
  ],
  security: [],
  advanced: [],
};

type PluginSetting = {
  solutionId: string;
  version: string;
  extensionId: string;
  contributionId: string;
  category: SettingCategory;
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
                category: "general" as SettingCategory,
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
        label: contribution.label,
        order: contribution.order ?? 100,
        component: contribution.component,
        schema: contribution.schema,
      }));
    }),
  ),
);

const activePluginSettings = computed(() =>
  pluginSettings.value
    .filter((item) => item.category === activeCategory.value)
    .sort((a, b) => a.order - b.order),
);

onMounted(() => {
  if (!extensions.loaded) void extensions.load();
});
</script>

<template>
  <div class="wf-page">
    <header class="wf-page-head">
      <div>
        <h1>统一设置</h1>
        <p class="wf-page-subtitle">平台基础设置 + 已安装业务方案提供的设置项</p>
      </div>
    </header>

    <nav class="wf-settings-tabs" aria-label="设置分类">
      <button
        v-for="category in categories"
        :key="category.key"
        class="wf-settings-tab"
        :class="{ active: activeCategory === category.key }"
        @click="activeCategory = category.key"
      >
        {{ category.label }}
      </button>
    </nav>

    <section class="wf-panel">
      <div class="wf-panel-head">
        <h2>{{ categories.find((item) => item.key === activeCategory)?.label }}</h2>
      </div>

      <div v-if="!extensions.loaded" class="wf-panel-body">
        <span class="wf-skeleton">正在加载设置…</span>
      </div>

      <div v-else class="wf-setting-list">
        <router-link
          v-for="item in nativeSettings[activeCategory]"
          :key="item.to"
          class="wf-setting-row"
          :to="item.to"
        >
          <WfIcon :name="item.icon" :size="18" />
          <div>
            <strong>{{ item.title }}</strong>
            <span>{{ item.description }}</span>
          </div>
          <span class="wf-link">打开 →</span>
        </router-link>

        <article
          v-for="item in activePluginSettings"
          :key="`${item.solutionId}:${item.extensionId}:${item.contributionId}`"
          class="wf-setting-row wf-setting-row-plugin"
        >
          <div class="wf-setting-plugin-head">
            <WfIcon name="engine" :size="18" />
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

        <div
          v-if="nativeSettings[activeCategory].length === 0 && activePluginSettings.length === 0"
          class="wf-empty"
        >
          <div>
            <strong>该分类暂无设置项</strong>
            <p>安装业务包后，其设置会自动出现在对应分类。</p>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.wf-page-subtitle {
  margin: 2px 0 0;
  color: var(--wf-text-muted);
  font-size: var(--wf-type-secondary);
}
.wf-settings-tabs {
  display: flex;
  gap: 6px;
  margin: 16px 0 12px;
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
  background: var(--wf-primary);
  border-color: var(--wf-primary);
  color: var(--wf-on-primary);
}
.wf-setting-list {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wf-setting-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--wf-border);
  border-radius: var(--wf-radius-control);
  background: var(--wf-surface);
  color: var(--wf-text);
  text-decoration: none;
  transition:
    border-color var(--wf-motion-fast) var(--wf-ease-out),
    box-shadow var(--wf-motion-fast) var(--wf-ease-out);
}
.wf-setting-row:hover {
  border-color: var(--wf-border-strong);
  box-shadow: 0 6px 20px rgba(14, 21, 18, 0.06);
}
.wf-setting-row svg {
  color: var(--wf-primary);
  flex: 0 0 auto;
}
.wf-setting-row div {
  flex: 1;
  min-width: 0;
}
.wf-setting-row strong {
  display: block;
  margin-bottom: 4px;
}
.wf-setting-row span {
  color: var(--wf-text-secondary);
  font-size: var(--wf-type-secondary);
  line-height: 1.5;
}
.wf-setting-row .wf-link {
  color: var(--wf-primary);
  white-space: nowrap;
}
.wf-setting-row-plugin {
  align-items: stretch;
  flex-direction: column;
}
.wf-setting-plugin-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.wf-setting-plugin-head svg {
  color: var(--wf-primary);
}
.wf-setting-plugin-head strong {
  display: block;
}
.wf-setting-plugin-head span {
  color: var(--wf-text-secondary);
  font-size: var(--wf-type-secondary);
}
</style>
