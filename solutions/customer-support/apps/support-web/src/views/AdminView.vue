<script setup lang="ts">
/**
 * 管理页（admin only）：白名单配置、系统设置两个 Tab。
 * AI 员工入口在「接待编排」（/support/pipeline）；回复策略已随
 * pipeline 化移除（策略不再以独立版本化文档存在）。
 * 非管理员由路由守卫重定向回工作台。
 */
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useWeflowAuthStore } from "../auth-store";
import WhitelistTab from "./admin/WhitelistTab.vue";
import SystemSettingsTab from "./admin/SystemSettingsTab.vue";

const auth = useWeflowAuthStore();
void auth.ensureSession();

const TABS = [
  { key: "whitelist", label: "白名单配置" },
  { key: "system-settings", label: "其他系统设置" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const route = useRoute();
const router = useRouter();

const activeTab = computed<TabKey>({
  get: () => {
    const raw = route.query.tab;
    if (typeof raw === "string" && TABS.some((tab) => tab.key === raw)) {
      return raw as TabKey;
    }
    return "whitelist";
  },
  set: (value: TabKey) => {
    void router.replace({ query: { ...route.query, tab: value } });
  },
});
</script>

<template>
  <div class="wf-page wf-page-wide wf-admin-page">
    <header class="wf-page-head">
      <div>
        <h1>管理</h1>
        <p>白名单和系统设置集中在此管理；AI 员工请前往「接待编排」。</p>
      </div>
    </header>

    <div class="wf-admin-tabs" role="tablist" aria-label="管理分区">
      <button
        v-for="tab in TABS"
        :key="tab.key"
        class="wf-admin-tab-button"
        :class="{ active: activeTab === tab.key }"
        role="tab"
        :aria-selected="activeTab === tab.key"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </div>

    <div class="wf-admin-body">
      <WhitelistTab v-if="activeTab === 'whitelist'" />
      <SystemSettingsTab v-else />
    </div>
  </div>
</template>

<style scoped>
.wf-admin-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.wf-admin-tabs {
  display: flex;
  gap: 4px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--wf-border, rgba(0, 0, 0, 0.08));
}
.wf-admin-tab-button {
  padding: 6px 14px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--wf-text-secondary, #5f6368);
  font-size: 13px;
  cursor: pointer;
}
.wf-admin-tab-button.active {
  color: #1a56c4;
  font-weight: 700;
  border-bottom-color: #1a56c4;
}
.wf-admin-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding-top: 12px;
}
</style>
