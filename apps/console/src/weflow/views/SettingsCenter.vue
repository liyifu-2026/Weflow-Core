<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useExtensionStore, type SettingField } from "../stores/extensions";
import { api } from "../api";
import WfIcon from "../components/WfIcon.vue";
import SettingForm from "../components/SettingForm.vue";
import PageHeader from "../components/PageHeader.vue";
import EmptyState from "../components/EmptyState.vue";

const extensions = useExtensionStore();

// ── 平台大模型设置（Operator Control Plane）──
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
    modelSettings.value = {
      ...modelSettings.value,
      settings: result.settings,
    };
    textApiKeyInput.value = "";
    visionApiKeyInput.value = "";
    asrApiKeyInput.value = "";
    triageApiKeyInput.value = "";
    fastApiKeyInput.value = "";
    modelNotice.value = "已保存；重启 Agent Worker 后生效";
  } catch (reason) {
    modelError.value =
      reason instanceof Error ? reason.message : "模型设置保存失败";
  } finally {
    modelSaving.value = false;
  }
}

const activeCategory = ref<string>("");
const searchQuery = ref("");

type PluginSetting = {
  solutionId: string;
  version: string;
  extensionId: string;
  contributionId: string;
  category: string;
  categoryLabel?: string;
  label: string;
  order: number;
  component?: string;
  schema?: SettingField[];
};

// Store 投影（@weflow/contracts ConsoleExtensionProjection）当前不携带
// 设置 schema；settings 贡献契约未来由 Solution 包重新提供后在这里接入。
const pluginSettings = computed<PluginSetting[]>(() => []);

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
  void loadModelSettings();
});
</script>

<template>
  <div class="wf-page wf-settings-page">
    <PageHeader title="系统设置" />

    <!-- 平台大模型设置：文本/视觉模型的 baseUrl、API Key、模型名；
         业务 Solution 通过 runtime-settings 直接消费平台模型 -->
    <section class="wf-panel wf-model-settings">
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
            <span
              class="wf-model-hint"
              data-tip="AI 回复生成使用的模型，业务 Solution 通过运行时设置直接消费。"
              >ⓘ 模型说明</span
            >
          </div>
          <div class="wf-model-fields">
            <select
              class="wf-input"
              v-model="modelSettings.settings.textModel.name"
              :disabled="modelSaving"
            >
              <option
                v-for="m in modelSettings.allowlists.text"
                :key="m"
                :value="m"
              >
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
            <span
              class="wf-model-hint"
              data-tip="图片理解使用的视觉模型（含语音转写），业务 Solution 通过运行时设置直接消费。"
              >ⓘ 模型说明</span
            >
          </div>
          <div class="wf-model-fields">
            <select
              class="wf-input"
              v-model="modelSettings.settings.visionModel.name"
              :disabled="modelSaving || !modelSettings.allowlists.vision.length"
            >
              <option
                v-for="m in modelSettings.allowlists.vision"
                :key="m"
                :value="m"
              >
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
            <span
              class="wf-model-hint"
              data-tip="语音消息转文字的专用小模型（OpenAI 兼容 audio/transcriptions，如硅基流动 XingChenASR），转写结果插入 Agent 思考上下文。"
              >ⓘ 模型说明</span
            >
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
        <div v-if="modelSettings.settings.fastModel" class="wf-model-row">
          <div class="wf-model-label">
            <strong>简单题直答模型</strong>
            <span
              class="wf-model-hint"
              data-tip="分流判定为“简单”时用于直接生成回复的轻量对话模型（如 GLM-4-9B），仍经过全部发送闸门；是否启用由业务链路配置页控制。"
              >ⓘ 模型说明</span
            >
          </div>
          <div class="wf-model-fields">
            <input
              class="wf-input"
              v-model="modelSettings.settings.fastModel!.name"
              placeholder="直答模型名"
              :disabled="modelSaving"
            />
            <input
              class="wf-input"
              v-model="modelSettings.settings.fastModel!.baseUrl"
              placeholder="Base URL"
              :disabled="modelSaving"
            />
            <input
              class="wf-input"
              v-model="fastApiKeyInput"
              type="password"
              :placeholder="
                modelSettings.settings.fastModel!.hasApiKey
                  ? 'API Key 已配置（留空保持不变）'
                  : 'API Key'
              "
              :disabled="modelSaving"
            />
          </div>
        </div>
        <div class="wf-model-actions">
          <button
            class="wf-button wf-button-primary"
            :disabled="modelSaving"
            @click="saveModelSettings"
          >
            {{ modelSaving ? "保存中…" : "保存模型设置" }}
          </button>
        </div>
      </div>
    </section>

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
.wf-model-settings {
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
.wf-model-hint {
  cursor: help;
  border-bottom: 1px dashed var(--wf-text-muted);
  width: fit-content;
  position: relative;
}
/* 自定义 tooltip：hover 停留显示说明（原生 title 在某些浏览器不可靠） */
.wf-model-hint::after {
  content: attr(data-tip);
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  z-index: 60;
  width: 280px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #1f2937;
  color: #e5e7eb;
  font-size: 12px;
  line-height: 1.5;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.24);
  opacity: 0;
  visibility: hidden;
  transition: opacity 140ms ease, visibility 140ms ease;
  pointer-events: none;
}
.wf-model-hint:hover::after,
.wf-model-hint:focus::after {
  opacity: 1;
  visibility: visible;
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
