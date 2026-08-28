<script setup lang="ts">
import { confirmDialog } from "../components/confirm-dialog";
import { computed, onMounted, ref } from "vue";
import { api } from "../api";
import {
  createManagedModel,
  createManagedStorageBackend,
  createManagedVectorStore,
  deleteManagedModel,
  listModels,
  listStorageBackends,
  listVectorStores,
  testManagedVectorStore,
  type ModelInfo,
  type StorageBackendInfo,
  type VectorStoreInfo,
} from "./api";
import {
  infraEngineLabel,
  infraProviderLabel,
  infraSourceLabel,
  infraStateLabel,
  modelTypeLabel,
} from "../labels";
import {
  listKnowledgeCapabilities,
  productStateCopy,
  productStateOf,
  updateKnowledgeCapability,
  type KnowledgeCapability,
} from "./capability-registry";

const expanded = ref(false);
const retrievalOpen = ref(false);
const retrieval = ref({
  embedding_top_k: 0,
  vector_threshold: 0,
  keyword_threshold: 0,
  rerank_top_k: 0,
  rerank_threshold: 0,
  rerank_model_id: "",
});
const retrievalError = ref("");
const retrievalLoaded = ref(false);
const retrievalSaved = ref(false);
/** 加载时的原始值快照：保存前 diff 提示，防止误覆盖 */
const retrievalOriginal = ref({
  embedding_top_k: 0,
  vector_threshold: 0,
  keyword_threshold: 0,
  rerank_top_k: 0,
  rerank_threshold: 0,
  rerank_model_id: "",
});
const saving = ref(false);

// 只读基础设施清单（P4 先读）：展开时才拉取，成功后把 registry
// 从 not_integrated 升级为 read_only —— 不开放任何写入入口。
const modelsOpen = ref(false);
const vectorOpen = ref(false);
const storageOpen = ref(false);
const models = ref<ModelInfo[]>([]);
const vectorStores = ref<VectorStoreInfo[]>([]);
const storageBackends = ref<{
  items: StorageBackendInfo[];
  defaultId?: string;
}>({ items: [], defaultId: undefined });
const infraError = ref("");

const EXPANDABLE_CAPABILITIES: Array<{
  key: KnowledgeCapability;
  label: string;
  detail: string;
}> = [
  { key: "models", label: "模型", detail: "Embedding、Rerank、问答模型" },
  { key: "vectorStores", label: "向量库", detail: "向量存储实例" },
  { key: "storage", label: "存储", detail: "文件存储后端" },
];

const STATIC_CAPABILITIES: Array<{
  key: KnowledgeCapability;
  label: string;
  detail: string;
}> = [
  { key: "parser", label: "解析与分块", detail: "Parser 引擎、Chunking、Parent-child、Multimodal、Graph 提取" },
  { key: "datasources", label: "数据源", detail: "Feishu、Notion、Yuque、RSS 同步" },
];

const registry = computed(() => listKnowledgeCapabilities());

function productState(key: KnowledgeCapability) {
  const state = registry.value.find((item) => item.capability === key);
  return productStateOf(state ?? {
    capability: key,
    upstream: "missing",
    serverContract: "missing",
    ui: "missing",
  });
}

// 「尚未就绪」只计真正不可用（未接入/暂不可用/不支持），
// 只读能力是就绪态，不应渲染成"没做好"。
const unavailableCount = computed(
  () =>
    [...EXPANDABLE_CAPABILITIES, ...STATIC_CAPABILITIES].filter(
      (item) =>
        ["not_integrated", "temporarily_unavailable", "unsupported"].includes(
          productState(item.key),
        ),
    ).length,
);

async function loadRetrieval() {
  retrievalError.value = "";
  try {
    const result = await api<{
      settings: {
        embeddingTopK: number;
        vectorThreshold: number;
        keywordThreshold: number;
        rerankTopK: number;
        rerankThreshold: number;
        rerankModelId: string;
      };
    }>("/api/v1/admin/retrieval-settings");
    retrieval.value = {
      embedding_top_k: result.settings.embeddingTopK,
      vector_threshold: result.settings.vectorThreshold,
      keyword_threshold: result.settings.keywordThreshold,
      rerank_top_k: result.settings.rerankTopK,
      rerank_threshold: result.settings.rerankThreshold,
      rerank_model_id: result.settings.rerankModelId,
    };
    retrievalOriginal.value = { ...retrieval.value };
    retrievalLoaded.value = true;
    retrievalSaved.value = false;
    updateKnowledgeCapability("retrieval", {
      serverContract: "available",
      ui: "implemented",
      reason: "explicit retrieval-settings contract (P0.2)",
    });
  } catch (reason) {
    retrievalError.value =
      reason instanceof Error ? reason.message : "检索配置加载失败";
  }
}

async function loadInfrastructure(kind: "models" | "vectorStores" | "storage") {
  infraError.value = "";
  try {
    if (kind === "models") {
      models.value = await listModels();
      updateKnowledgeCapability("models", {
        ui: "partial",
        reason: "read-only list wired (P4)",
      });
    } else if (kind === "vectorStores") {
      vectorStores.value = await listVectorStores();
      updateKnowledgeCapability("vectorStores", {
        ui: "partial",
        reason: "read-only list wired (P4)",
      });
    } else {
      storageBackends.value = await listStorageBackends();
      updateKnowledgeCapability("storage", {
        ui: "partial",
        reason: "read-only list wired (P4)",
      });
    }
  } catch (reason) {
    infraError.value =
      reason instanceof Error ? reason.message : "能力清单加载失败";
  }
}

function toggleModels() {
  modelsOpen.value = !modelsOpen.value;
  if (modelsOpen.value && !models.value.length) void loadInfrastructure("models");
}
function toggleVectorStores() {
  vectorOpen.value = !vectorOpen.value;
  if (vectorOpen.value && !vectorStores.value.length)
    void loadInfrastructure("vectorStores");
}
function toggleStorage() {
  storageOpen.value = !storageOpen.value;
  if (storageOpen.value && !storageBackends.value.items.length)
    void loadInfrastructure("storage");
}

// ---------- 受控治理（创建 / 删除 / 测试连接） ----------
type ManageKind = "model" | "vector" | "storage";
const manageOpen = ref<ManageKind | null>(null);
const manageForm = ref({
  name: "",
  type: "Chat",
  source: "remote",
  display_name: "",
  description: "",
  engine_type: "postgres",
  provider: "local",
});
const manageBusy = ref(false);
const manageError = ref("");
const manageResult = ref(""); // 测试连接结果展示

const MODEL_TYPES = ["Chat", "KnowledgeQA", "Embedding", "Rerank", "VLLM"];
const VECTOR_ENGINES = ["postgres", "milvus", "chroma", "qdrant"];
const STORAGE_PROVIDERS = ["local", "s3", "minio", "oss", "cos"];

function openManage(kind: ManageKind) {
  manageOpen.value = kind;
  manageError.value = "";
  manageResult.value = "";
  manageForm.value = {
    name: "",
    type: "Chat",
    source: "remote",
    display_name: "",
    description: "",
    engine_type: "postgres",
    provider: "local",
  };
}

async function submitManage() {
  if (!manageOpen.value || manageBusy.value) return;
  manageBusy.value = true;
  manageError.value = "";
  manageResult.value = "";
  try {
    const kind = manageOpen.value;
    if (kind === "model") {
      await createManagedModel({
        name: manageForm.value.name.trim(),
        type: manageForm.value.type,
        source: manageForm.value.source,
        display_name: manageForm.value.display_name.trim() || undefined,
        description: manageForm.value.description.trim() || undefined,
      });
    } else if (kind === "vector") {
      await createManagedVectorStore({
        name: manageForm.value.name.trim(),
        engine_type: manageForm.value.engine_type,
      });
    } else {
      await createManagedStorageBackend({
        name: manageForm.value.name.trim(),
        provider: manageForm.value.provider,
      });
    }
    manageOpen.value = null;
    await loadInfrastructure(
      kind === "vector"
        ? "vectorStores"
        : kind === "storage"
          ? "storage"
          : "models",
    );
    infraError.value = "";
  } catch (reason) {
    manageError.value =
      reason instanceof Error ? reason.message : "创建失败";
  } finally {
    manageBusy.value = false;
  }
}

async function testVectorConnection(store: VectorStoreInfo) {
  manageResult.value = "";
  manageError.value = "";
  manageBusy.value = true;
  try {
    const result = await testManagedVectorStore({
      name: store.name,
      engine_type: store.engine_type ?? "",
    });
    const raw = result as { result?: { success?: boolean; error?: string } };
    manageResult.value = raw.result?.success
      ? `「${store.name}」连接测试通过。`
      : `「${store.name}」连接测试：${raw.result?.error ?? "失败"}`;
  } catch (reason) {
    manageError.value =
      reason instanceof Error ? reason.message : "测试失败";
  } finally {
    manageBusy.value = false;
  }
}

async function removeModel(model: ModelInfo) {
  if (model.is_default || model.is_builtin) return;
  if (
    !await confirmDialog(
      `删除模型「${model.display_name || model.name}」？

该操作会写入审计，且影响使用此模型的知识检索。`,
    )
  )
    return;
  manageBusy.value = true;
  manageError.value = "";
  try {
    await deleteManagedModel(model.id);
    models.value = models.value.filter((item) => item.id !== model.id);
  } catch (reason) {
    manageError.value =
      reason instanceof Error ? reason.message : "删除失败";
  } finally {
    manageBusy.value = false;
  }
}

function modelCredentialLabel(model: ModelInfo): string {
  if (!model.credentials) return "";
  const configured = Object.values(model.credentials).some(
    (entry) => entry?.configured,
  );
  return configured ? "凭据已配置" : "凭据未配置";
}

const RETRIEVAL_FIELD_LABELS: Record<string, string> = {
  embedding_top_k: "Dense 召回数",
  vector_threshold: "向量阈值",
  keyword_threshold: "关键词阈值",
  rerank_top_k: "Rerank 召回数",
  rerank_threshold: "Rerank 阈值",
  rerank_model_id: "Rerank 模型",
};

function retrievalDiffSummary(): string {
  const changed: string[] = [];
  for (const key of Object.keys(RETRIEVAL_FIELD_LABELS) as Array<
    keyof typeof retrieval.value
  >) {
    if (retrieval.value[key] !== retrievalOriginal.value[key])
      changed.push(RETRIEVAL_FIELD_LABELS[key]);
  }
  return changed.join("、");
}

async function saveRetrieval() {
  // 数据保护：加载失败后禁止保存（避免把零值/空串覆盖到线上配置）。
  if (!retrievalLoaded.value) {
    retrievalError.value = "检索配置尚未成功加载，保存已禁用。请先重新加载。";
    return;
  }
  const changed = retrievalDiffSummary();
  if (!changed) {
    retrievalError.value = "没有需要保存的修改。";
    return;
  }
  // 检索参数影响线上问答，属高影响操作：保存前确认改动范围。
  if (
    !await confirmDialog(
      `将修改检索配置：${changed}。

该配置影响线上知识检索效果，确认保存？`,
    )
  )
    return;
  saving.value = true;
  retrievalError.value = "";
  retrievalSaved.value = false;
  try {
    const result = await api<{ settings: unknown }>(
      "/api/v1/admin/retrieval-settings",
      {
        method: "PUT",
        body: JSON.stringify(retrieval.value),
      },
    );
    retrieval.value = result.settings as typeof retrieval.value;
    retrievalOriginal.value = { ...retrieval.value };
    retrievalSaved.value = true;
  } catch (reason) {
    retrievalError.value =
      reason instanceof Error ? reason.message : "保存失败";
  } finally {
    saving.value = false;
  }
}

function toggleRetrieval() {
  retrievalOpen.value = !retrievalOpen.value;
  if (retrievalOpen.value) {
    void loadRetrieval();
    // rerank 模型选择器需要模型清单。
    if (!models.value.length) void loadInfrastructure("models");
  }
}

onMounted(() => {
  if (productState("retrieval") !== "unsupported") void loadRetrieval();
});
</script>

<template>
  <div class="wf-page-body wf-config-summary">
    <section class="wf-section-block">
      <div class="wf-section-heading">
        <h2>知识配置</h2>
      </div>
      <div class="wf-config-list">
        <div class="wf-config-row">
          <div>
            <strong>解析</strong>
            <span class="wf-muted">Parser 引擎、分块方式</span>
            <p class="wf-muted" style="margin: 4px 0 0; font-size: 12px">
              当前部署未注册解析引擎，分块使用部署默认配置。
              如需自定义解析，请联系部署方在上游服务中注册。
            </p>
          </div>
          <span
            class="wf-status"
            :class="{ warn: productState('parser') !== 'available' }"
            >{{ productStateCopy(productState("parser")).title }}</span
          >
        </div>
        <div class="wf-config-row" role="button" tabindex="0" @click="toggleRetrieval" @keyup.enter="toggleRetrieval">
          <div>
            <strong>检索</strong>
            <span class="wf-muted">Dense、BM25、Rerank 与阈值</span>
          </div>
          <span class="wf-status" :class="{ warn: productState('retrieval') !== 'available' }">{{
            productStateCopy(productState("retrieval")).title
          }}</span>
        </div>
      </div>

      <div v-if="retrievalOpen" class="wf-inline-section">
        <div v-if="retrievalError" class="wf-error">{{ retrievalError }}</div>
        <div v-if="retrievalSaved" class="wf-notice">检索配置已保存。</div>
        <div v-if="!retrievalLoaded && !retrievalError" class="wf-error">
          检索配置加载中…
        </div>
        <div class="wf-grid">
          <div class="wf-field wf-span-4">
            <label>Dense 召回数</label>
            <input v-model.number="retrieval.embedding_top_k" type="number" min="0" max="100" class="wf-input" placeholder="默认 50" />
            <span class="wf-muted">向量检索返回的候选数量，越大召回越多、噪声越高。</span>
          </div>
          <div class="wf-field wf-span-4">
            <label>向量阈值</label>
            <input v-model.number="retrieval.vector_threshold" type="number" min="0" max="1" step="0.05" class="wf-input" placeholder="默认 0.15" />
            <span class="wf-muted">向量相似度下限（0-1），低于该值的结果被丢弃。</span>
          </div>
          <div class="wf-field wf-span-4">
            <label>关键词阈值</label>
            <input v-model.number="retrieval.keyword_threshold" type="number" min="0" max="1" step="0.05" class="wf-input" placeholder="默认 0.3" />
            <span class="wf-muted">BM25 关键词匹配下限（0-1）。</span>
          </div>
          <div class="wf-field wf-span-4">
            <label>Rerank 召回数</label>
            <input v-model.number="retrieval.rerank_top_k" type="number" min="0" max="100" class="wf-input" placeholder="默认 10" />
            <span class="wf-muted">重排后保留给回答生成的数量。</span>
          </div>
          <div class="wf-field wf-span-4">
            <label>Rerank 阈值</label>
            <input v-model.number="retrieval.rerank_threshold" type="number" min="0" max="1" step="0.05" class="wf-input" placeholder="默认 0.2" />
            <span class="wf-muted">重排得分下限（0-1）。</span>
          </div>
          <div class="wf-field wf-span-4">
            <label>Rerank 模型</label>
            <select
              v-model="retrieval.rerank_model_id"
              class="wf-select"
              :disabled="!models.length"
            >
              <option value="">未设置</option>
              <option
                v-for="model in models"
                :key="model.id"
                :value="model.id"
              >
                {{ model.display_name || model.name }}（{{
                  modelTypeLabel(model.type)
                }}）
              </option>
            </select>
            <span v-if="!models.length" class="wf-muted"
              >模型清单不可用，可手动填写模型 ID。</span
            >
          </div>
        </div>
        <div class="wf-actions">
          <span class="wf-section-caption">仅白名单参数，未知配置不会被修改。</span>
          <button
            class="wf-button compact primary"
            :disabled="saving || !retrievalLoaded"
            @click="saveRetrieval"
          >
            {{ saving ? "保存中" : "保存" }}
          </button>
        </div>
      </div>
    </section>

    <button class="wf-link wf-link-button wf-config-more" @click="expanded = !expanded">
      {{ expanded ? "收起" : `更多能力 · ${unavailableCount} 项尚未就绪 →` }}
    </button>

    <section v-if="expanded" class="wf-section-block">
      <div class="wf-section-heading">
        <h2>能力状态</h2>
      </div>
      <div class="wf-config-list">
        <div
          v-for="item in EXPANDABLE_CAPABILITIES"
          :key="item.key"
          class="wf-config-row"
          role="button"
          tabindex="0"
          @click="
            item.key === 'models'
              ? toggleModels()
              : item.key === 'vectorStores'
                ? toggleVectorStores()
                : toggleStorage()
          "
          @keyup.enter="
            item.key === 'models'
              ? toggleModels()
              : item.key === 'vectorStores'
                ? toggleVectorStores()
                : toggleStorage()
          "
        >
          <div>
            <strong>{{ item.label }}</strong>
            <span class="wf-muted">{{ item.detail }}</span>
          </div>
          <span class="wf-status" :class="{ warn: productState(item.key) !== 'available' }">{{
            productStateCopy(productState(item.key)).title
          }}</span>
        </div>

        <div v-if="modelsOpen" class="wf-inline-section">
          <div v-if="infraError" class="wf-error">{{ infraError }}</div>
          <div class="wf-infra-toolbar">
            <span class="wf-section-caption">模型</span>
            <button class="wf-button compact" @click="openManage('model')">
              + 新建模型
            </button>
          </div>
          <template v-if="models.length">
            <div v-for="model in models" :key="model.id" class="wf-infra-row">
              <div class="wf-infra-main">
                <strong>{{ model.display_name || model.name }}</strong>
                <span class="wf-muted"
                  >{{ modelTypeLabel(model.type) }} · {{ infraSourceLabel(model.source) }}{{
                    model.parameters?.embedding_parameters?.dimension
                      ? ` · 维度 ${model.parameters.embedding_parameters.dimension}`
                      : ""
                  }}{{
                    model.created_at
                      ? ` · ${new Date(model.created_at).toLocaleDateString()}`
                      : ""
                  }}</span
                >
              </div>
              <div class="wf-infra-side">
                <span v-if="model.is_default" class="wf-status good">默认</span>
                <span class="wf-status" :class="{ warn: model.status !== 'active' }">{{
                  infraStateLabel(model.status)
                }}</span>
                <span class="wf-muted">{{ modelCredentialLabel(model) }}</span>
                <button
                  v-if="!model.is_default && !model.is_builtin"
                  class="wf-link wf-link-button danger"
                  :disabled="manageBusy"
                  @click="removeModel(model)"
                >
                  删除
                </button>
              </div>
            </div>
          </template>
          <p v-else class="wf-muted wf-config-note">当前部署未注册模型。</p>
        </div>

        <div v-if="vectorOpen" class="wf-inline-section">
          <div v-if="infraError" class="wf-error">{{ infraError }}</div>
          <div class="wf-infra-toolbar">
            <span class="wf-section-caption">向量库</span>
            <button class="wf-button compact" @click="openManage('vector')">
              + 新建向量库
            </button>
          </div>
          <template v-if="vectorStores.length">
            <div v-for="store in vectorStores" :key="store.id" class="wf-infra-row">
              <div class="wf-infra-main">
                <strong>{{ store.name }}</strong>
                <span class="wf-muted"
                  >{{ infraEngineLabel(store.engine_type) }} · {{ infraSourceLabel(store.source) }}{{
                    store.created_at && store.created_at !== "0001-01-01T00:00:00Z"
                      ? ` · ${new Date(store.created_at).toLocaleDateString()}`
                      : ""
                  }}</span
                >
              </div>
              <div class="wf-infra-side">
                <span v-if="store.readonly" class="wf-status warn">只读</span>
                <span v-if="store.connection_config?.use_default_connection" class="wf-muted"
                  >默认连接</span
                >
                <button
                  class="wf-link wf-link-button"
                  :disabled="manageBusy"
                  @click="testVectorConnection(store)"
                >
                  测试连接
                </button>
              </div>
            </div>
          </template>
          <p v-else class="wf-muted wf-config-note">当前部署未注册向量库。</p>
        </div>

        <div v-if="storageOpen" class="wf-inline-section">
          <div v-if="infraError" class="wf-error">{{ infraError }}</div>
          <div class="wf-infra-toolbar">
            <span class="wf-section-caption">存储</span>
            <button class="wf-button compact" @click="openManage('storage')">
              + 新建存储
            </button>
          </div>
          <template v-if="storageBackends.items.length">
            <div
              v-for="backend in storageBackends.items"
              :key="backend.id"
              class="wf-infra-row"
            >
              <div class="wf-infra-main">
                <strong>{{ backend.name }}</strong>
                <span class="wf-muted"
                  >{{ infraProviderLabel(backend.provider) }} · {{ infraSourceLabel(backend.source) }}{{
                    backend.updated_at
                      ? ` · 更新于 ${new Date(backend.updated_at).toLocaleDateString()}`
                      : ""
                  }}</span
                >
              </div>
              <div class="wf-infra-side">
                <span v-if="backend.id === storageBackends.defaultId" class="wf-status good"
                  >默认</span
                >
                <span class="wf-status" :class="{ warn: backend.status !== 'active' }">{{
                  infraStateLabel(backend.status)
                }}</span>
              </div>
            </div>
          </template>
          <p v-else class="wf-muted wf-config-note">当前部署未注册存储后端。</p>
        </div>

        <div
          v-for="item in STATIC_CAPABILITIES"
          :key="item.key"
          class="wf-config-row"
        >
          <div>
            <strong>{{ item.label }}</strong>
            <span class="wf-muted">{{ item.detail }}</span>
          </div>
          <span class="wf-status" :class="{ warn: productState(item.key) !== 'available' }">{{
            productStateCopy(productState(item.key)).title
          }}</span>
        </div>
        <div v-if="manageResult" class="wf-notice">{{ manageResult }}</div>
        <div v-if="manageError" class="wf-error">{{ manageError }}</div>
        <p class="wf-muted wf-config-note">
          模型、向量库与存储的创建与删除会写入审计并立即影响线上检索，操作前请确认。这些设置属于低频专业能力，只对管理员开放。
        </p>
      </div>
    </section>
    <!-- 受控治理：创建表单 -->
    <div v-if="manageOpen" class="wf-modal-mask" @click.self="manageOpen = null">
      <div class="wf-modal wf-modal-narrow">
        <div class="wf-modal-head">
          <h3>
            {{
              manageOpen === "model"
                ? "新建模型"
                : manageOpen === "vector"
                  ? "新建向量库"
                  : "新建存储"
            }}
          </h3>
          <button class="wf-icon-button" @click="manageOpen = null">×</button>
        </div>
        <div class="wf-modal-body">
          <div class="wf-field">
            <label>名称</label>
            <input v-model="manageForm.name" class="wf-input" />
          </div>
          <template v-if="manageOpen === 'model'">
            <div class="wf-field">
              <label>类型</label>
              <select v-model="manageForm.type" class="wf-select">
                <option v-for="t in MODEL_TYPES" :key="t" :value="t">
                  {{ t }}
                </option>
              </select>
            </div>
            <div class="wf-field">
              <label>来源</label>
              <select v-model="manageForm.source" class="wf-select">
                <option value="remote">远程</option>
                <option value="local">本地</option>
                <option value="builtin">内置</option>
              </select>
            </div>
            <div class="wf-field">
              <label>显示名称（可选）</label>
              <input v-model="manageForm.display_name" class="wf-input" />
            </div>
            <div class="wf-field">
              <label>描述（可选）</label>
              <input v-model="manageForm.description" class="wf-input" />
            </div>
            <p class="wf-muted" style="font-size: 12px">
              上游暂不支持通过创建接口配置参数与凭据；创建后如需修改请联系部署方。
            </p>
          </template>
          <template v-else-if="manageOpen === 'vector'">
            <div class="wf-field">
              <label>引擎类型</label>
              <select v-model="manageForm.engine_type" class="wf-select">
                <option v-for="e in VECTOR_ENGINES" :key="e" :value="e">
                  {{ e }}
                </option>
              </select>
            </div>
          </template>
          <template v-else>
            <div class="wf-field">
              <label>提供方</label>
              <select v-model="manageForm.provider" class="wf-select">
                <option v-for="p in STORAGE_PROVIDERS" :key="p" :value="p">
                  {{ p }}
                </option>
              </select>
            </div>
          </template>
        </div>
        <div class="wf-modal-foot">
          <button class="wf-button" @click="manageOpen = null">取消</button>
          <button
            class="wf-button primary"
            :disabled="manageBusy || !manageForm.name.trim()"
            @click="submitManage"
          >
            {{ manageBusy ? "创建中" : "创建" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wf-infra-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid var(--wf-border);
  font-size: 13px;
}
.wf-infra-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.wf-infra-side {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
</style>

