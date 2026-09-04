<script setup lang="ts">
/**
 * 设置中心 · ② 模型分区：统一模型注册表 + 槽位绑定 + 健康状态。
 * 模型 = 名称 + 端点 + 密钥 + 能力标签（文本/视觉/语音）+ 故障转移链。
 * 保存后热生效（消费方 15s 轮询失效，无需重启）。
 */
import { onMounted, ref } from "vue";
import { api } from "../../api";

type ModelEntry = {
  modelId: string;
  displayName: string;
  baseUrl: string;
  hasApiKey: boolean;
  capabilities: string[];
  timeoutMs: number;
  failoverTo: string | null;
  enabled: boolean;
};

type ModelHealth = {
  modelId: string;
  displayName: string;
  lastSuccess: boolean | null;
  lastFailureReason: string | null;
  lastCheckedAt: number | null;
  successCount: number;
  failureCount: number;
};

type GatewayResponse = {
  models: ModelEntry[];
  slots: Record<string, string | null>;
  health: ModelHealth[];
};

const SLOTS: Array<{ key: string; label: string; desc: string }> = [
  { key: "text", label: "主力文本", desc: "AI 回复生成的主力模型" },
  { key: "vision", label: "视觉", desc: "图片理解（含语音转写兜底）" },
  { key: "asr", label: "语音转写", desc: "语音消息转文字专用小模型" },
  { key: "triage", label: "预判分流", desc: "高危/简单判定的极速小模型" },
  { key: "fast", label: "直答", desc: "简单题直答的轻量对话模型" },
];

const CAPABILITIES = ["text", "vision", "asr"] as const;
const CAPABILITY_LABELS: Record<string, string> = {
  text: "文本",
  vision: "视觉",
  asr: "语音",
};

const data = ref<GatewayResponse | null>(null);
const loading = ref(true);
const saving = ref(false);
const notice = ref("");
const error = ref("");
/** 新建表单 */
const creating = ref(false);
const newModel = ref({
  modelId: "",
  displayName: "",
  baseUrl: "",
  apiKey: "",
  capabilities: ["text"] as string[],
  timeoutMs: 60_000,
  failoverTo: "" as string | null,
});
/** 编辑中的条目：modelId → 草稿 */
const editing = ref<Record<string, Partial<ModelEntry> & { apiKey?: string }>>({});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    data.value = await api<GatewayResponse>("/api/v1/admin/model-gateway");
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "模型网关加载失败";
  } finally {
    loading.value = false;
  }
}

function draft(model: ModelEntry) {
  return (
    editing.value[model.modelId] ?? {
      displayName: model.displayName,
      baseUrl: model.baseUrl,
      capabilities: [...model.capabilities],
      timeoutMs: model.timeoutMs,
      failoverTo: model.failoverTo,
      enabled: model.enabled,
      apiKey: "",
    }
  );
}

function startEdit(model: ModelEntry) {
  editing.value = { ...editing.value, [model.modelId]: draft(model) };
}

function cancelEdit(modelId: string) {
  const next = { ...editing.value };
  delete next[modelId];
  editing.value = next;
}

async function saveModel(model: ModelEntry) {
  const patch = editing.value[model.modelId];
  if (!patch || saving.value) return;
  saving.value = true;
  notice.value = "";
  error.value = "";
  try {
    const body: Record<string, unknown> = {
      displayName: patch.displayName,
      baseUrl: patch.baseUrl,
      capabilities: patch.capabilities,
      timeoutMs: patch.timeoutMs,
      failoverTo: patch.failoverTo || null,
      enabled: patch.enabled,
    };
    if (patch.apiKey && patch.apiKey.trim() !== "") {
      body.apiKey = patch.apiKey.trim();
    }
    await api(
      `/api/v1/admin/model-gateway/models/${encodeURIComponent(model.modelId)}`,
      { method: "PUT", body: JSON.stringify(body) },
    );
    cancelEdit(model.modelId);
    notice.value = "已保存；约 15 秒内生效，无需重启";
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "模型保存失败";
  } finally {
    saving.value = false;
  }
}

async function createModel() {
  if (!newModel.value.modelId.trim() || !newModel.value.baseUrl.trim() || saving.value)
    return;
  saving.value = true;
  notice.value = "";
  error.value = "";
  try {
    const body: Record<string, unknown> = {
      displayName: newModel.value.displayName || newModel.value.modelId,
      baseUrl: newModel.value.baseUrl.trim(),
      capabilities: newModel.value.capabilities,
      timeoutMs: newModel.value.timeoutMs,
      failoverTo: newModel.value.failoverTo || null,
      enabled: true,
    };
    if (newModel.value.apiKey.trim() !== "") {
      body.apiKey = newModel.value.apiKey.trim();
    }
    await api("/api/v1/admin/model-gateway/models/" + encodeURIComponent(newModel.value.modelId.trim()), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    creating.value = false;
    newModel.value = {
      modelId: "",
      displayName: "",
      baseUrl: "",
      apiKey: "",
      capabilities: ["text"],
      timeoutMs: 60_000,
      failoverTo: null,
    };
    notice.value = "模型已创建";
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "模型创建失败";
  } finally {
    saving.value = false;
  }
}

async function removeModel(model: ModelEntry) {
  if (!window.confirm(`删除模型「${model.displayName}」？槽位绑定将指向空。`)) return;
  saving.value = true;
  try {
    await api(`/api/v1/admin/model-gateway/models/${encodeURIComponent(model.modelId)}`, {
      method: "DELETE",
    });
    notice.value = "已删除";
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "删除失败";
  } finally {
    saving.value = false;
  }
}

async function bindSlot(slot: string, event: Event) {
  const target = event.target as HTMLSelectElement;
  saving.value = true;
  error.value = "";
  try {
    await api(`/api/v1/admin/model-gateway/slots/${encodeURIComponent(slot)}`, {
      method: "PUT",
      body: JSON.stringify({ modelId: target.value || null }),
    });
    notice.value = "槽位已更新；约 15 秒内生效";
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "槽位绑定失败";
  } finally {
    saving.value = false;
  }
}

function healthOf(modelId: string): ModelHealth | undefined {
  return data.value?.health.find((h) => h.modelId === modelId);
}

function healthLabel(modelId: string): { text: string; cls: string } {
  const health = healthOf(modelId);
  if (!health || health.lastSuccess === null)
    return { text: "未探测", cls: "" };
  return health.lastSuccess
    ? { text: "正常", cls: "good" }
    : { text: "异常", cls: "bad" };
}

onMounted(load);
</script>

<template>
  <div class="wf-section">
    <section class="wf-settings-card">
      <div class="wf-settings-card-head">
        <strong>模型槽位</strong>
        <span class="spacer" />
        <span v-if="notice" class="wf-settings-notice">{{ notice }}</span>
        <span v-if="error" class="wf-settings-error">{{ error }}</span>
      </div>
      <div v-if="loading" class="wf-settings-body">
        <span class="wf-skeleton">正在加载模型网关…</span>
      </div>
      <div v-else-if="data" class="wf-settings-body">
        <p class="wf-settings-hint">
          槽位决定各业务环节用哪个模型。绑定后从注册表取端点与密钥；未绑定的槽位回落 .env 首次种子配置。
        </p>
        <div v-for="slot in SLOTS" :key="slot.key" class="wf-form-row">
          <label>
            <strong>{{ slot.label }}</strong>
            <span>{{ slot.desc }}</span>
          </label>
          <select
            class="wf-input"
            :value="data.slots[slot.key] ?? ''"
            :disabled="saving"
            @change="bindSlot(slot.key, $event)"
          >
            <option value="">未绑定（回落 .env 种子）</option>
            <option
              v-for="model in data.models.filter((m) => m.enabled)"
              :key="model.modelId"
              :value="model.modelId"
            >
              {{ model.displayName }}（{{ model.modelId }}）
            </option>
          </select>
        </div>
      </div>
    </section>

    <section class="wf-settings-card">
      <div class="wf-settings-card-head">
        <strong>模型注册表</strong>
        <span class="spacer" />
        <button class="wf-button compact" @click="creating = !creating">
          {{ creating ? "取消新建" : "+ 新建模型" }}
        </button>
      </div>
      <div v-if="creating" class="wf-settings-body wf-new-model">
        <div class="wf-form-row">
          <label><strong>模型 ID</strong><span>唯一标识（如 deepseek-v4-flash）</span></label>
          <input v-model="newModel.modelId" class="wf-input" placeholder="model-id" />
        </div>
        <div class="wf-form-row">
          <label><strong>模型名</strong><span>请求上游时使用的模型名</span></label>
          <input v-model="newModel.displayName" class="wf-input" placeholder="deepseek-v4-flash" />
        </div>
        <div class="wf-form-row">
          <label><strong>端点 Base URL</strong></label>
          <input v-model="newModel.baseUrl" class="wf-input" placeholder="https://api.example.com/v1" />
        </div>
        <div class="wf-form-row">
          <label><strong>API Key</strong></label>
          <input v-model="newModel.apiKey" type="password" class="wf-input" placeholder="sk-…" />
        </div>
        <div class="wf-form-row">
          <label><strong>能力标签</strong></label>
          <div class="wf-cap-row">
            <label v-for="cap in CAPABILITIES" :key="cap" class="wf-cap">
              <input
                type="checkbox"
                :checked="newModel.capabilities.includes(cap)"
                @change="
                  ($event.target as HTMLInputElement).checked
                    ? newModel.capabilities.push(cap)
                    : (newModel.capabilities = newModel.capabilities.filter((c) => c !== cap))
                "
              />
              {{ CAPABILITY_LABELS[cap] }}
            </label>
          </div>
        </div>
        <div class="wf-form-row">
          <label><strong>故障转移 →</strong><span>主模型失败/超时自动切到该模型</span></label>
          <select v-model="newModel.failoverTo" class="wf-input" :disabled="!data">
            <option :value="null">无</option>
            <option v-for="model in data?.models ?? []" :key="model.modelId" :value="model.modelId">
              {{ model.displayName }}
            </option>
          </select>
        </div>
        <div class="wf-form-actions">
          <button class="wf-button primary" :disabled="saving || !newModel.modelId.trim() || !newModel.baseUrl.trim()" @click="createModel">
            {{ saving ? "创建中…" : "创建模型" }}
          </button>
        </div>
      </div>
      <div v-if="data && data.models.length" class="wf-settings-body">
        <div v-for="model in data.models" :key="model.modelId" class="wf-model-item">
          <div class="wf-model-line">
            <span class="wf-status" :class="healthLabel(model.modelId).cls">
              {{ healthLabel(model.modelId).text }}
            </span>
            <strong>{{ model.displayName }}</strong>
            <code class="wf-mono">{{ model.modelId }}</code>
            <span v-if="!model.enabled" class="wf-status warn">已禁用</span>
            <span class="spacer" />
            <button v-if="!editing[model.modelId]" class="wf-button compact" @click="startEdit(model)">编辑</button>
            <button class="wf-button compact danger" :disabled="saving" @click="removeModel(model)">删除</button>
          </div>
          <div v-if="!editing[model.modelId]" class="wf-model-meta">
            <span>{{ model.baseUrl }}</span>
            <span>{{ model.capabilities.map((c) => CAPABILITY_LABELS[c] ?? c).join(" / ") || "无标签" }}</span>
            <span v-if="model.failoverTo">故障转移 → {{ model.failoverTo }}</span>
            <span>超时 {{ Math.round(model.timeoutMs / 1000) }}s</span>
            <span>{{ model.hasApiKey ? "密钥已配置" : "无密钥" }}</span>
          </div>
          <div v-else class="wf-settings-body wf-edit-form">
            <div class="wf-form-row">
              <label><strong>模型名</strong></label>
              <input v-model="editing[model.modelId]!.displayName" class="wf-input" />
            </div>
            <div class="wf-form-row">
              <label><strong>端点 Base URL</strong></label>
              <input v-model="editing[model.modelId]!.baseUrl" class="wf-input" />
            </div>
            <div class="wf-form-row">
              <label><strong>API Key</strong><span>{{ model.hasApiKey ? "留空保持不变" : "未配置" }}</span></label>
              <input v-model="editing[model.modelId]!.apiKey" type="password" class="wf-input" placeholder="留空保持不变" />
            </div>
            <div class="wf-form-row">
              <label><strong>能力标签</strong></label>
              <div class="wf-cap-row">
                <label v-for="cap in CAPABILITIES" :key="cap" class="wf-cap">
                  <input
                    type="checkbox"
                    :checked="(editing[model.modelId]!.capabilities ?? []).includes(cap)"
                    @change="
                      ($event.target as HTMLInputElement).checked
                        ? editing[model.modelId]!.capabilities?.push(cap)
                        : (editing[model.modelId]!.capabilities = (editing[model.modelId]!.capabilities ?? []).filter((c) => c !== cap))
                    "
                  />
                  {{ CAPABILITY_LABELS[cap] }}
                </label>
              </div>
            </div>
            <div class="wf-form-row">
              <label><strong>故障转移 →</strong></label>
              <select v-model="editing[model.modelId]!.failoverTo" class="wf-input">
                <option :value="null">无</option>
                <option
                  v-for="other in data!.models.filter((m) => m.modelId !== model.modelId)"
                  :key="other.modelId"
                  :value="other.modelId"
                >
                  {{ other.displayName }}
                </option>
              </select>
            </div>
            <div class="wf-form-row">
              <label><strong>启用</strong></label>
              <label class="wf-switch">
                <input v-model="editing[model.modelId]!.enabled" type="checkbox" />
                <span class="wf-switch-slider" />
              </label>
            </div>
            <div class="wf-form-actions">
              <button class="wf-button" @click="cancelEdit(model.modelId)">取消</button>
              <button class="wf-button primary" :disabled="saving" @click="saveModel(model)">
                {{ saving ? "保存中…" : "保存" }}
              </button>
            </div>
          </div>
        </div>
      </div>
      <div v-else-if="data" class="wf-settings-body">
        <div class="wf-empty wf-empty-compact">
          <div>
            <strong>注册表为空</strong>
            <p>新建模型并绑定槽位；未绑定时回落 .env 首次种子配置（仅首次部署生效）。</p>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
@import "./settings-shared.css";
.wf-model-item {
  border: 1px solid var(--wf-border, rgba(0, 0, 0, 0.08));
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wf-model-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wf-model-line strong {
  font-size: 13px;
}
.wf-model-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 12px;
  color: var(--wf-text-secondary, #5f6368);
}
.wf-cap-row {
  display: flex;
  gap: 12px;
}
.wf-cap {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12.5px;
}
.wf-edit-form {
  padding: 8px 0 0;
  border-top: 1px dashed var(--wf-border, rgba(0, 0, 0, 0.08));
}
.wf-status {
  font-size: 12px;
}
.wf-status.good {
  color: #137333;
}
.wf-status.bad {
  color: #d93025;
}
.wf-status.warn {
  color: #b26a00;
}
</style>
