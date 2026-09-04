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
import {
  BookOpen,
  Bot,
  Radio,
  Server,
  Settings2,
  Shield,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-vue-next";
import { cn } from "@/lib/utils";
import SettingsAiEmployees from "./settings/SettingsAiEmployees.vue";
import SettingsModels from "./settings/SettingsModels.vue";
import SettingsKnowledge from "./settings/SettingsKnowledge.vue";
import SettingsBehavior from "./settings/SettingsBehavior.vue";
import SettingsChannel from "./settings/SettingsChannel.vue";
import SettingsSecurity from "./settings/SettingsSecurity.vue";
import SettingsDeployment from "./settings/SettingsDeployment.vue";

const SECTIONS: Array<{ key: string; label: string; icon: LucideIcon }> = [
  { key: "aiEmployees", label: "AI 员工", icon: Bot },
  { key: "models", label: "模型", icon: Settings2 },
  { key: "knowledge", label: "知识库", icon: BookOpen },
  { key: "behavior", label: "行为", icon: SlidersHorizontal },
  { key: "channel", label: "通道", icon: Radio },
  { key: "security", label: "安全", icon: Shield },
  { key: "deployment", label: "部署", icon: Server },
];

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
  <div class="mx-auto w-full max-w-5xl p-6">
    <header class="mb-6">
      <h1 class="text-2xl font-semibold tracking-tight">设置中心</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        AI 员工 / 模型 / 知识库 / 行为 / 通道 / 安全 / 部署。改动即时生效，无需重启。
      </p>
    </header>

    <div class="grid gap-6 lg:grid-cols-[180px_minmax(0,1fr)] lg:items-start">
      <nav aria-label="设置分区" class="flex gap-1 overflow-x-auto lg:sticky lg:top-6 lg:flex-col lg:overflow-visible">
        <button
          v-for="section in SECTIONS"
          :key="section.key"
          type="button"
          class="inline-flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          :class="cn(active === section.key && 'bg-accent font-medium text-accent-foreground')"
          @click="select(section.key)"
        >
          <component :is="section.icon" class="size-4 text-muted-foreground" />
          <span>{{ section.label }}</span>
        </button>
      </nav>

      <div class="min-w-0">
        <component :is="activeComponent" />
      </div>
    </div>
  </div>
</template>
