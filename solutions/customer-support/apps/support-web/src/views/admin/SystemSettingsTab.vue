<script setup lang="ts">
/**
 * 管理页 Tab：其他系统设置。
 * 对接 Core Operator Control Plane：GET/PATCH /api/v1/admin/runtime-settings。
 * 开关/模型选择即时 PATCH，失败回滚并提示；审计由 Core 统一记录。
 */
import { onMounted, ref } from "vue";
import { api } from "../../api";

type RuntimeSettings = {
  agentEnabled: boolean;
  autoSendEnabled: boolean;
  knowledgeEnabled: boolean;
  memoryEnabled: boolean;
  visionEnabled: boolean;
  textModel: string;
  visionModel: string;
};

type RuntimeSettingsResponse = {
  settings: RuntimeSettings;
  allowlists: { text: string[]; vision: string[] };
};

const SWITCH_ROWS: Array<{
  key: keyof RuntimeSettings &
    (
      | "agentEnabled"
      | "autoSendEnabled"
      | "knowledgeEnabled"
      | "memoryEnabled"
      | "visionEnabled"
    );
  label: string;
  desc: string;
}> = [
  {
    key: "agentEnabled",
    label: "AI 自动应答",
    desc: "关闭后新消息不再触发 AI 回复（不影响人工操作）。",
  },
  {
    key: "autoSendEnabled",
    label: "自动发送",
    desc: "关闭后 AI 回复只生成草稿，不自动发送到通道。",
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
const allowlists = ref<{ text: string[]; vision: string[] }>({
  text: [],
  vision: [],
});
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const notice = ref("");
const syncing = ref(false);
const syncNotice = ref("");

/** 请求 Channel Host 以历史回溯通道重扫微信历史消息。
 *  补到的漏捕消息按 historical 事件入库：只入会话记录，绝不触发 AI 回复、
 *  记忆提取或通知（零副作用）；已入库消息自动去重，不会重复。 */
async function syncChannelMessages() {
  if (syncing.value) return;
  syncing.value = true;
  syncNotice.value = "";
  try {
    const result = await api<{ synced: boolean; started: boolean }>(
      "/api/v1/admin/channel/sync",
      { method: "POST" },
    );
    syncNotice.value = result.started
      ? "已开始后台回溯微信历史消息（漏捕的补入会话，不触发 AI/通知）"
      : "同步请求未生效";
  } catch (reason) {
    syncNotice.value =
      reason instanceof Error ? `同步失败：${reason.message}` : "同步失败";
  } finally {
    syncing.value = false;
  }
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const result = await api<RuntimeSettingsResponse>(
      "/api/v1/admin/runtime-settings",
    );
    settings.value = result.settings;
    allowlists.value = result.allowlists;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "设置加载失败";
  } finally {
    loading.value = false;
  }
}

async function patch(patch: Partial<RuntimeSettings>) {
  if (!settings.value || saving.value) return;
  const snapshot = { ...settings.value };
  Object.assign(settings.value, patch);
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    const result = await api<{ settings: RuntimeSettings }>(
      "/api/v1/admin/runtime-settings",
      { method: "PATCH", body: JSON.stringify(patch) },
    );
    settings.value = result.settings;
    notice.value = "已保存";
  } catch (reason) {
    settings.value = snapshot;
    error.value = reason instanceof Error ? reason.message : "设置保存失败";
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="wf-admin-tab">
    <div v-if="error" class="wf-error">
      <span>{{ error }}</span>
      <button class="wf-button compact" @click="load">重试</button>
    </div>
    <div v-if="loading && !settings" class="wf-queue-loading">
      <div v-for="i in 4" :key="i" class="wx-row">
        <div class="wf-skeleton wf-skeleton-title"></div>
        <div class="wf-skeleton wf-skeleton-line"></div>
      </div>
    </div>
    <template v-else-if="settings">
      <div class="wf-settings-card">
        <div class="wf-settings-card-head">
          <strong>运行开关</strong>
          <span v-if="notice" class="wf-settings-notice">{{ notice }}</span>
        </div>
        <div
          v-for="row in SWITCH_ROWS"
          :key="row.key"
          class="wf-settings-row"
        >
          <div class="wf-settings-label">
            <strong>{{ row.label }}</strong>
            <span>{{ row.desc }}</span>
          </div>
          <label class="wf-switch">
            <input
              type="checkbox"
              :checked="Boolean(settings[row.key])"
              :disabled="saving"
              @change="
                patch({ [row.key]: !settings![row.key] } as Partial<RuntimeSettings>)
              "
            />
            <span class="wf-switch-slider"></span>
          </label>
        </div>
      </div>
      <div class="wf-settings-card">
        <div class="wf-settings-card-head">
          <strong>消息同步</strong>
          <span v-if="syncNotice" class="wf-settings-notice">{{
            syncNotice
          }}</span>
        </div>
        <div class="wf-settings-row">
          <div class="wf-settings-label">
            <strong>同步微信历史消息</strong>
            <span>后台重扫微信聊天记录，补入漏捕消息；只入库展示，不触发 AI 回复、记忆提取或通知。</span>
          </div>
          <button
            class="wf-button"
            :disabled="syncing"
            @click="syncChannelMessages"
          >
            {{ syncing ? "同步中…" : "立即同步" }}
          </button>
        </div>
      </div>
      <div class="wf-settings-card">
        <div class="wf-settings-card-head">
          <strong>模型</strong>
        </div>
        <div class="wf-settings-row">
          <div class="wf-settings-label">
            <strong>文本模型</strong>
            <span>AI 回复生成使用的文本模型。</span>
          </div>
          <select
            class="wf-input wf-select"
            :value="settings.textModel"
            :disabled="saving"
            @change="
              patch({ textModel: ($event.target as HTMLSelectElement).value })
            "
          >
            <option v-for="model in allowlists.text" :key="model" :value="model">
              {{ model }}
            </option>
          </select>
        </div>
        <div class="wf-settings-row">
          <div class="wf-settings-label">
            <strong>视觉模型</strong>
            <span>图片理解使用的视觉模型。</span>
          </div>
          <select
            class="wf-input wf-select"
            :value="settings.visionModel"
            :disabled="saving || !allowlists.vision.length"
            @change="
              patch({ visionModel: ($event.target as HTMLSelectElement).value })
            "
          >
            <option
              v-for="model in allowlists.vision"
              :key="model"
              :value="model"
            >
              {{ model }}
            </option>
          </select>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.wf-admin-tab {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 0;
}
.wf-settings-card {
  border: 1px solid var(--wf-border, rgba(0, 0, 0, 0.08));
  border-radius: 12px;
  background: var(--wf-surface, #fff);
  overflow: hidden;
}
.wf-settings-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--wf-border, rgba(0, 0, 0, 0.06));
  background: var(--wf-surface-hover, rgba(0, 0, 0, 0.02));
}
.wf-settings-notice {
  font-size: 12px;
  color: #137333;
}
.wf-settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--wf-border, rgba(0, 0, 0, 0.05));
}
.wf-settings-row:last-child {
  border-bottom: 0;
}
.wf-settings-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.wf-settings-label strong {
  font-size: 13px;
  color: var(--wf-text, #17181a);
}
.wf-settings-label span {
  font-size: 12px;
  color: var(--wf-text-secondary, #5f6368);
}
.wf-select {
  width: 200px;
}
/* switch（与 WhitelistView 保持一致） */
.wf-switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
}
.wf-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.wf-switch-slider {
  position: absolute;
  inset: 0;
  background: #c4c7c5;
  border-radius: 999px;
  transition: background 120ms ease;
  cursor: pointer;
}
.wf-switch-slider::before {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: #fff;
  border-radius: 50%;
  transition: transform 120ms ease;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
}
.wf-switch input:checked + .wf-switch-slider {
  background: #1a56c4;
}
.wf-switch input:checked + .wf-switch-slider::before {
  transform: translateX(16px);
}
.wf-switch input:disabled + .wf-switch-slider {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
