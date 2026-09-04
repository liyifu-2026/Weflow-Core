<script setup lang="ts">
/**
 * 设置中心占位（admin only）。
 *
 * R2 将把这里重建为七分区设置中心：AI员工 / 模型 / 知识库 / 行为 /
 * 通道 / 安全 / 部署。本阶段仅保留平台大模型设置（文本 / 视觉 / ASR /
 * 预判分流 / 直答模型），其余分区显示占位说明。
 */
import { onMounted, ref } from "vue";
import { api } from "../api";

type ModelSettingView = {
  name: string;
  baseUrl: string;
  hasApiKey: boolean;
};
type ModelSettingsResponse = {
  settings: {
    textModel: ModelSettingView;
    visionModel: ModelSettingView;
    asrModel: ModelSettingView;
    triageModel?: ModelSettingView;
    fastModel?: ModelSettingView;
  };
  allowlists: { text: string[]; vision: string[] };
};

const modelSettings = ref<ModelSettingsResponse | null>(null);
const textApiKeyInput = ref("");
const visionApiKeyInput = ref("");
const asrApiKeyInput = ref("");
const triageApiKeyInput = ref("");
const fastApiKeyInput = ref("");
const modelSaving = ref(false);
const modelError = ref("");
const modelNotice = ref("");

async function loadModelSettings() {
  modelError.value = "";
  try {
    modelSettings.value = await api<ModelSettingsResponse>(
      "/api/v1/admin/model-settings",
    );
    textApiKeyInput.value = "";
    visionApiKeyInput.value = "";
    asrApiKeyInput.value = "";
    triageApiKeyInput.value = "";
    fastApiKeyInput.value = "";
  } catch (reason) {
    modelError.value =
      reason instanceof Error ? reason.message : "模型设置加载失败";
  }
}

async function saveModelSettings() {
  if (!modelSettings.value || modelSaving.value) return;
  modelSaving.value = true;
  modelError.value = "";
  modelNotice.value = "";
  try {
    const patch: {
      textModel?: { name?: string; baseUrl?: string; apiKey?: string };
      visionModel?: { name?: string; baseUrl?: string; apiKey?: string };
      asrModel?: { name?: string; baseUrl?: string; apiKey?: string };
      triageModel?: { name?: string; baseUrl?: string; apiKey?: string };
      fastModel?: { name?: string; baseUrl?: string; apiKey?: string };
    } = {};
    const text = modelSettings.value.settings.textModel;
    const vision = modelSettings.value.settings.visionModel;
    const asr = modelSettings.value.settings.asrModel;
    patch.textModel = { name: text.name, baseUrl: text.baseUrl };
    if (textApiKeyInput.value.trim() !== "") {
      patch.textModel.apiKey = textApiKeyInput.value.trim();
    }
    patch.visionModel = { name: vision.name, baseUrl: vision.baseUrl };
    if (visionApiKeyInput.value.trim() !== "") {
      patch.visionModel.apiKey = visionApiKeyInput.value.trim();
    }
    patch.asrModel = { name: asr.name, baseUrl: asr.baseUrl };
    if (asrApiKeyInput.value.trim() !== "") {
      patch.asrModel.apiKey = asrApiKeyInput.value.trim();
    }
    const triage = modelSettings.value.settings.triageModel;
    if (triage) {
      patch.triageModel = { name: triage.name, baseUrl: triage.baseUrl };
      if (triageApiKeyInput.value.trim() !== "") {
        patch.triageModel.apiKey = triageApiKeyInput.value.trim();
      }
    }
    const fast = modelSettings.value.settings.fastModel;
    if (fast) {
      patch.fastModel = { name: fast.name, baseUrl: fast.baseUrl };
      if (fastApiKeyInput.value.trim() !== "") {
        patch.fastModel.apiKey = fastApiKeyInput.value.trim();
      }
    }
    const result = await api<{ settings: ModelSettingsResponse["settings"] }>(
      "/api/v1/admin/model-settings",
      { method: "PATCH", body: JSON.stringify(patch) },
    );
    modelSettings.value = { ...modelSettings.value, settings: result.settings };
    textApiKeyInput.value = "";
    visionApiKeyInput.value = "";
    asrApiKeyInput.value = "";
    triageApiKeyInput.value = "";
    fastApiKeyInput.value = "";
    modelNotice.value = "已保存，约 15 秒内自动生效，无需重启";
  } catch (reason) {
    modelError.value =
      reason instanceof Error ? reason.message : "模型设置保存失败";
  } finally {
    modelSaving.value = false;
  }
}

onMounted(loadModelSettings);
</script>

<template>
  <div class="wf-page wf-settings-page">
    <header class="wf-page-head">
      <div>
        <h1>设置</h1>
        <p>设置中心（R2 重建为七分区：AI员工 / 模型 / 知识库 / 行为 / 通道 / 安全 / 部署）。</p>
      </div>
    </header>

    <section class="wf-panel">
      <div class="wf-panel-head">
        <h2>平台大模型</h2>
        <span v-if="modelNotice" class="wf-settings-notice">{{ modelNotice }}</span>
        <span v-if="modelError" class="wf-settings-error">{{ modelError }}</span>
      </div>
      <div v-if="!modelSettings" class="wf-panel-body">
        <span class="wf-skeleton">正在加载模型设置…</span>
      </div>
      <div v-else class="wf-model-form">
        <div class="wf-model-row">
          <div class="wf-model-label">
            <strong>文本模型</strong>
            <span>AI 回复生成使用的模型。</span>
          </div>
          <div class="wf-model-fields">
            <select
              class="wf-input"
              v-model="modelSettings.settings.textModel.name"
              :disabled="modelSaving"
            >
              <option v-for="m in modelSettings.allowlists.text" :key="m" :value="m">
                {{ m }}
              </option>
            </select>
            <input
              class="wf-input"
              v-model="modelSettings.settings.textModel.baseUrl"
              placeholder="Base URL"
              :disabled="modelSaving"
            />
            <input
              class="wf-input"
              v-model="textApiKeyInput"
              type="password"
              :placeholder="
                modelSettings.settings.textModel.hasApiKey
                  ? 'API Key 已配置（留空保持不变）'
                  : 'API Key'
              "
              :disabled="modelSaving"
            />
          </div>
        </div>
        <div class="wf-model-row">
          <div class="wf-model-label">
            <strong>视觉模型</strong>
            <span>图片理解使用的视觉模型（含语音转写）。</span>
          </div>
          <div class="wf-model-fields">
            <select
              class="wf-input"
              v-model="modelSettings.settings.visionModel.name"
              :disabled="modelSaving || !modelSettings.allowlists.vision.length"
            >
              <option v-for="m in modelSettings.allowlists.vision" :key="m" :value="m">
                {{ m }}
              </option>
            </select>
            <input
              class="wf-input"
              v-model="modelSettings.settings.visionModel.baseUrl"
              placeholder="Base URL"
              :disabled="modelSaving"
            />
            <input
              class="wf-input"
              v-model="visionApiKeyInput"
              type="password"
              :placeholder="
                modelSettings.settings.visionModel.hasApiKey
                  ? 'API Key 已配置（留空保持不变）'
                  : 'API Key'
              "
              :disabled="modelSaving"
            />
          </div>
        </div>
        <div class="wf-model-row">
          <div class="wf-model-label">
            <strong>语音转写（ASR）</strong>
            <span>语音消息转文字的专用小模型，转写结果插入 Agent 思考上下文。</span>
          </div>
          <div class="wf-model-fields">
            <input
              class="wf-input"
              v-model="modelSettings.settings.asrModel.name"
              placeholder="ASR 模型名"
              :disabled="modelSaving"
            />
            <input
              class="wf-input"
              v-model="modelSettings.settings.asrModel.baseUrl"
              placeholder="Base URL"
              :disabled="modelSaving"
            />
            <input
              class="wf-input"
              v-model="asrApiKeyInput"
              type="password"
              :placeholder="
                modelSettings.settings.asrModel.hasApiKey
                  ? 'API Key 已配置（留空保持不变）'
                  : 'API Key'
              "
              :disabled="modelSaving"
            />
          </div>
        </div>
        <div v-if="modelSettings.settings.triageModel" class="wf-model-row">
          <div class="wf-model-label">
            <strong>预判分流模型</strong>
            <span>预判分流判定使用的极速小模型；判定失败/超时自动放行主力接待。</span>
          </div>
          <div class="wf-model-fields">
            <input
              class="wf-input"
              v-model="modelSettings.settings.triageModel.name"
              placeholder="分流模型名"
              :disabled="modelSaving"
            />
            <input
              class="wf-input"
              v-model="modelSettings.settings.triageModel.baseUrl"
              placeholder="Base URL"
              :disabled="modelSaving"
            />
            <input
              class="wf-input"
              v-model="triageApiKeyInput"
              type="password"
              :placeholder="
                modelSettings.settings.triageModel.hasApiKey
                  ? 'API Key 已配置（留空保持不变）'
                  : 'API Key'
              "
              :disabled="modelSaving"
            />
          </div>
        </div>
        <div v-if="modelSettings.settings.fastModel" class="wf-model-row">
          <div class="wf-model-label">
            <strong>简单题直答模型</strong>
            <span>分流判定为「简单」时用于直接生成回复的轻量对话模型。</span>
          </div>
          <div class="wf-model-fields">
            <input
              class="wf-input"
              v-model="modelSettings.settings.fastModel.name"
              placeholder="直答模型名"
              :disabled="modelSaving"
            />
            <input
              class="wf-input"
              v-model="modelSettings.settings.fastModel.baseUrl"
              placeholder="Base URL"
              :disabled="modelSaving"
            />
            <input
              class="wf-input"
              v-model="fastApiKeyInput"
              type="password"
              :placeholder="
                modelSettings.settings.fastModel.hasApiKey
                  ? 'API Key 已配置（留空保持不变）'
                  : 'API Key'
              "
              :disabled="modelSaving"
            />
          </div>
        </div>
        <div class="wf-model-actions">
          <button
            class="wf-button primary"
            :disabled="modelSaving"
            @click="saveModelSettings"
          >
            {{ modelSaving ? "保存中…" : "保存模型设置" }}
          </button>
        </div>
      </div>
    </section>

    <section class="wf-panel">
      <div class="wf-panel-head">
        <h2>更多分区</h2>
      </div>
      <div class="wf-panel-body">
        <div class="wf-empty wf-empty-compact">
          <div>
            <strong>设置中心整合中</strong>
            <p>AI员工 / 知识库 / 行为 / 通道 / 安全 / 部署分区将在下一阶段集中于此。</p>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.wf-settings-page {
  max-width: 960px;
}
.wf-panel {
  margin-bottom: 16px;
}
.wf-model-form {
  padding: 8px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.wf-model-row {
  display: grid;
  grid-template-columns: 180px 1fr;
  gap: 16px;
  align-items: start;
}
.wf-model-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 8px;
}
.wf-model-label strong {
  font-size: 13px;
}
.wf-model-label span {
  font-size: 12px;
  color: var(--wf-text-secondary);
}
.wf-model-fields {
  display: grid;
  grid-template-columns: 1fr 1.4fr 1.4fr;
  gap: 8px;
}
.wf-model-actions {
  display: flex;
  justify-content: flex-end;
}
.wf-settings-notice {
  font-size: 12px;
  color: #137333;
}
.wf-settings-error {
  font-size: 12px;
  color: #d93025;
}
@media (max-width: 860px) {
  .wf-model-row {
    grid-template-columns: 1fr;
  }
}
</style>
