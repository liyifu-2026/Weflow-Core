<script setup lang="ts">
import { ref } from "vue";
import ConversationsView from "./views/ConversationsView.vue";
import PromptManager from "./views/PromptManager.vue";
import SupportConfirmDialog from "./components/SupportConfirmDialog.vue";

type Tab = "workbench" | "prompts";

const activeTab = ref<Tab>("workbench");
</script>

<template>
  <div class="support-app">
    <nav class="support-tabs">
      <button
        class="support-tab"
        :class="{ active: activeTab === 'workbench' }"
        @click="activeTab = 'workbench'"
      >
        客服工作台
      </button>
      <button
        class="support-tab"
        :class="{ active: activeTab === 'prompts' }"
        @click="activeTab = 'prompts'"
      >
        Prompt 配置
      </button>
    </nav>

    <ConversationsView v-if="activeTab === 'workbench'" />
    <PromptManager v-else-if="activeTab === 'prompts'" />
    <SupportConfirmDialog />
  </div>
</template>

<style scoped>
.support-app {
  min-height: 100vh;
}

.support-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, rgba(0, 0, 0, 0.06));
  background: var(--surface, #ffffff);
  position: sticky;
  top: 0;
  z-index: 10;
}

.support-tab {
  min-height: 30px;
  padding: 4px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary, #5f6368);
  cursor: pointer;
  font-size: 13px;
}

.support-tab.active {
  color: var(--primary, #17181a);
  background: var(--primary-soft, rgba(0, 0, 0, 0.05));
  font-weight: 700;
}
</style>
