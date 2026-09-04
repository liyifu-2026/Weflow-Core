<script setup lang="ts">
/**
 * 设置中心 · ④ 行为分区：全局运行开关（含合并窗口——R2 补 UI）
 * + Kill Switch 瞬时暂停。对接 Core GET/PATCH /api/v1/admin/runtime-settings。
 */
import { onMounted, ref } from "vue";
import { api } from "../../api";

type RuntimeSettings = {
  agentEnabled: boolean;
  autoSendEnabled: boolean;
  knowledgeEnabled: boolean;
  memoryEnabled: boolean;
  visionEnabled: boolean;
  mergeWindowEnabled: boolean;
};

const SWITCH_ROWS: Array<{
  key: keyof RuntimeSettings;
  label: string;
  desc: string;
}> = [
  {
    key: "agentEnabled",
    label: "AI 自动应答（Kill Switch）",
    desc: "关闭后新消息不再触发 AI 回复（瞬时暂停，不影响人工操作与已入队 Turn 的落库）。",
  },
  {
    key: "autoSendEnabled",
    label: "自动发送",
    desc: "关闭后 AI 回复只生成草稿，不自动发送到通道。",
  },
  {
    key: "mergeWindowEnabled",
    label: "合并窗口",
    desc: "开启后入站消息先进窗合并、到期才建 Agent Turn（省模型调用）；关闭则逐条建 Turn。",
  },
  {
    key: "knowledgeEnabled",
    label: "知识检索",
    desc: "AI 回复时是否检索知识库作为回答依据。",
  },
  {
    key: "memoryEnabled",
    label: "长期记忆",
    desc: "AI 是否记录并召回客户相关的长期记忆。",
  },
  {
    key: "visionEnabled",
    label: "图像理解",
    desc: "AI 是否解析客户发送的图片。",
  },
];

const settings = ref<RuntimeSettings | null>(null);
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const notice = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const result = await api<{ settings: RuntimeSettings }>(
      "/api/v1/admin/runtime-settings",
    );
    settings.value = result.settings;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "设置加载失败";
  } finally {
    loading.value = false;
  }
}

async function patch(key: keyof RuntimeSettings) {
  if (!settings.value || saving.value) return;
  const snapshot = { ...settings.value };
  const next = !settings.value[key];
  settings.value[key] = next;
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    const result = await api<{ settings: RuntimeSettings }>(
      "/api/v1/admin/runtime-settings",
      { method: "PATCH", body: JSON.stringify({ [key]: next }) },
    );
    settings.value = result.settings;
    notice.value = "已保存，即时生效";
  } catch (reason) {
    settings.value = snapshot;
    error.value = reason instanceof Error ? reason.message : "保存失败";
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="wf-section">
    <section class="wf-settings-card">
      <div class="wf-settings-card-head">
        <strong>全局运行开关</strong>
        <span v-if="notice" class="wf-settings-notice">{{ notice }}</span>
        <span v-if="error" class="wf-settings-error">{{ error }}</span>
      </div>
      <div v-if="loading && !settings" class="wf-settings-body">
        <span class="wf-skeleton">正在加载运行开关…</span>
      </div>
      <div v-else-if="settings" class="wf-settings-body">
        <div v-for="row in SWITCH_ROWS" :key="row.key" class="wf-form-row">
          <label>
            <strong>{{ row.label }}</strong>
            <span>{{ row.desc }}</span>
          </label>
          <label class="wf-switch">
            <input
              type="checkbox"
              :checked="Boolean(settings[row.key])"
              :disabled="saving"
              @change="patch(row.key)"
            />
            <span class="wf-switch-slider" />
          </label>
        </div>
      </div>
    </section>
    <section class="wf-settings-card">
      <div class="wf-settings-card-head">
        <strong>消息同步</strong>
      </div>
      <div class="wf-settings-body">
        <p class="wf-settings-hint">
          微信历史消息回溯已迁移至系统状态页维护；此处仅保留运行时开关。
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
@import "./settings-shared.css";
</style>
