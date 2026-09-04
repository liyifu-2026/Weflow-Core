<script setup lang="ts">
/**
 * 设置中心（R2，admin only）：单页七分区。
 *
 * ① AI员工：入口链接 + 行为参数（会话TTL/轮数上限/wait上限/nudge话术/
 *    ReAct预算——R2 起提升为可配，存扩展设置 behavior 键）+ 模式开关说明
 * ② 模型：统一模型注册表（名称/端点/密钥/能力标签/故障转移链）+ 槽位
 *    绑定 + 健康状态（R2 模型网关）
 * ③ 知识库：通用连接器（检索端点/认证/字段映射 JSON），WeKnora 为预设
 * ④ 行为：全局开关（AI应答/自动发送/合并窗口/知识/记忆/视觉）+ Kill Switch
 * ⑤ 通道：Channel Host 探活只读
 * ⑥ 安全：白名单入口 + 群聊策略（自接待编排页收编）
 * ⑦ 部署：环境只读展示（改 .env 重启生效）
 */
import { computed, onMounted, ref, watch } from "vue";
import WfIcon from "../components/WfIcon.vue";
import SettingsAiEmployees from "./settings/SettingsAiEmployees.vue";
import SettingsModels from "./settings/SettingsModels.vue";
import SettingsKnowledge from "./settings/SettingsKnowledge.vue";
import SettingsBehavior from "./settings/SettingsBehavior.vue";
import SettingsChannel from "./settings/SettingsChannel.vue";
import SettingsSecurity from "./settings/SettingsSecurity.vue";
import SettingsDeployment from "./settings/SettingsDeployment.vue";

const SECTIONS = [
  { key: "aiEmployees", label: "AI员工", icon: "agent" },
  { key: "models", label: "模型", icon: "engine" },
  { key: "knowledge", label: "知识库", icon: "knowledge" },
  { key: "behavior", label: "行为", icon: "verify" },
  { key: "channel", label: "通道", icon: "runtime" },
  { key: "security", label: "安全", icon: "users" },
  { key: "deployment", label: "部署", icon: "settings" },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

const active = ref<SectionKey>("aiEmployees");
const activeComponent = computed(() => {
  switch (active.value) {
    case "models":
      return SettingsModels;
    case "knowledge":
      return SettingsKnowledge;
    case "behavior":
      return SettingsBehavior;
    case "channel":
      return SettingsChannel;
    case "security":
      return SettingsSecurity;
    case "deployment":
      return SettingsDeployment;
    default:
      return SettingsAiEmployees;
  }
});

watch(active, () => {
  window.scrollTo(0, 0);
});

onMounted(() => {
  const hash = window.location.hash.replace("#", "");
  if (SECTIONS.some((section) => section.key === hash)) {
    active.value = hash as SectionKey;
  }
});

function select(key: SectionKey) {
  active.value = key;
  window.history.replaceState(null, "", `#${key}`);
}
</script>

<template>
  <div class="wf-page wf-settings-center">
    <header class="wf-page-head">
      <div>
        <h1>设置中心</h1>
        <p>七分区集中管理：AI员工 / 模型 / 知识库 / 行为 / 通道 / 安全 / 部署。改动即时生效，无需重启。</p>
      </div>
    </header>
    <div class="wf-settings-layout">
      <nav class="wf-settings-nav" aria-label="设置分区">
        <button
          v-for="section in SECTIONS"
          :key="section.key"
          class="wf-settings-nav-item"
          :class="{ active: active === section.key }"
          @click="select(section.key)"
        >
          <WfIcon :name="section.icon" />
          <span>{{ section.label }}</span>
        </button>
      </nav>
      <section class="wf-settings-panel">
        <component :is="activeComponent" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.wf-settings-center {
  max-width: 1200px;
}
.wf-settings-layout {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.wf-settings-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid var(--wf-border, rgba(0, 0, 0, 0.08));
  border-radius: 12px;
  background: var(--wf-surface, #fff);
  padding: 8px;
  position: sticky;
  top: 16px;
}
.wf-settings-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: transparent;
  border-radius: 8px;
  padding: 8px 12px;
  font: inherit;
  font-size: 13px;
  color: var(--wf-text, #17181a);
  cursor: pointer;
  text-align: left;
}
.wf-settings-nav-item:hover {
  background: var(--wf-surface-hover, rgba(0, 0, 0, 0.04));
}
.wf-settings-nav-item.active {
  background: var(--wf-primary-soft, rgba(37, 99, 235, 0.1));
  color: var(--wf-primary, #2563eb);
  font-weight: 600;
}
.wf-settings-panel {
  min-width: 0;
}
@media (max-width: 860px) {
  .wf-settings-layout {
    grid-template-columns: 1fr;
  }
  .wf-settings-nav {
    position: static;
    flex-direction: row;
    flex-wrap: wrap;
  }
}
</style>
