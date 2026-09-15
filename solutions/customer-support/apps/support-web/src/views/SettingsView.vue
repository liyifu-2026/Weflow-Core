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
 * ⑤ 安全：联系人策略入口 + 群聊策略（自接待编排页收编）
 * ⑥ 部署：环境只读展示（改 .env 重启生效）
 *
 * 通道状态（原 Channel 分区）已并入「系统状态」页（UX-DECISIONS §5）。
 * dirty 保护：容器捕获 input/change 标记当前分区有未保存更改，
 * 切分区/离开时经 confirmDialog 确认；各 Tab 保存成功后 emit("saved") 清除。
 */
import { computed, ref, watch } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import {
  BookOpen,
  Bot,
  Server,
  Settings2,
  Shield,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-vue-next";
import { cn } from "@/lib/utils";
import { confirmDialog } from "../components/confirm-dialog";
import SettingsAiEmployees from "./settings/SettingsAiEmployees.vue";
import SettingsModels from "./settings/SettingsModels.vue";
import SettingsKnowledge from "./settings/SettingsKnowledge.vue";
import SettingsBehavior from "./settings/SettingsBehavior.vue";
import SettingsSecurity from "./settings/SettingsSecurity.vue";
import SettingsDeployment from "./settings/SettingsDeployment.vue";

const SECTIONS: Array<{ key: string; label: string; icon: LucideIcon }> = [
  { key: "aiEmployees", label: "AI 员工", icon: Bot },
  { key: "models", label: "模型", icon: Settings2 },
  { key: "knowledge", label: "知识库", icon: BookOpen },
  { key: "behavior", label: "行为", icon: SlidersHorizontal },
  { key: "security", label: "安全", icon: Shield },
  { key: "deployment", label: "部署", icon: Server },
];

type SectionKey = (typeof SECTIONS)[number]["key"];

const route = useRoute();
const router = useRouter();

const active = computed<SectionKey>(() => {
  const raw = route.query.section;
  if (typeof raw === "string" && SECTIONS.some((s) => s.key === raw)) {
    return raw as SectionKey;
  }
  return "aiEmployees";
});

const activeComponent = computed(() => {
  switch (active.value) {
    case "models":
      return SettingsModels;
    case "knowledge":
      return SettingsKnowledge;
    case "behavior":
      return SettingsBehavior;
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
  clearDirty();
});

// ---- dirty 保护（UX-DECISIONS §5）----
const dirty = ref(false);
function markDirty() {
  dirty.value = true;
}
function clearDirty() {
  dirty.value = false;
}
async function guardSwitch(key: SectionKey) {
  if (key === active.value) return;
  if (
    dirty.value &&
    !(await confirmDialog("当前分区有未保存的更改，确定切换？", { danger: true }))
  ) {
    return;
  }
  clearDirty();
  void router.replace({ query: { ...route.query, section: key } });
}
onBeforeRouteLeave(async () => {
  if (
    !dirty.value ||
    (await confirmDialog("当前分区有未保存的更改，确定离开？", { danger: true }))
  ) {
    clearDirty();
    return true;
  }
  return false;
});
</script>

<template>
  <div class="mx-auto w-full max-w-5xl p-6">
    <header class="mb-6">
      <h1 class="text-2xl font-semibold tracking-tight">设置中心</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        AI 员工 / 模型 / 知识库 / 行为 / 安全 / 部署。改动即时生效，无需重启。
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
          @click="guardSwitch(section.key)"
        >
          <component :is="section.icon" class="size-4 text-muted-foreground" />
          <span>{{ section.label }}</span>
        </button>
      </nav>

      <div class="min-w-0" @input.capture="markDirty" @change.capture="markDirty">
        <component :is="activeComponent" @saved="clearDirty" />
      </div>
    </div>
  </div>
</template>
