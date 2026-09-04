<script setup lang="ts">
/**
 * 设置中心 · ③ 知识库分区：通用 RESTful 连接器。
 * 连接器类型 / 检索端点 / 认证方式 / 请求响应字段映射 JSON / 管理端点可选。
 * WeKnora 为预设模板；配置存扩展设置 knowledgeConnector 键。
 */
import { onMounted, ref } from "vue";
import {
  readPipelineSettings,
  writePipelineSettings,
} from "./common";

type ConnectorConfig = {
  type: string;
  retrieveUrl: string;
  authMode: "none" | "bearer" | "header";
  authHeader: string;
  authValue: string;
  requestMapping: string;
  responseMapping: string;
  adminUrl: string;
};

const WEKNORA_TEMPLATE: ConnectorConfig = {
  type: "weknora",
  retrieveUrl: "",
  authMode: "bearer",
  authHeader: "Authorization",
  authValue: "",
  requestMapping: '{"query":"$.query","knowledgeBaseIds":"$.knowledge_base_ids"}',
  responseMapping: '{"evidence":"$.data[*]","chunkId":"$.chunk_id","content":"$.content","score":"$.score"}',
  adminUrl: "",
};

const DEFAULTS: ConnectorConfig = {
  type: "",
  retrieveUrl: "",
  authMode: "none",
  authHeader: "",
  authValue: "",
  requestMapping: "",
  responseMapping: "",
  adminUrl: "",
};

const config = ref<ConnectorConfig>({ ...DEFAULTS });
const rawSettings = ref<Record<string, unknown>>({});
const loading = ref(true);
const saving = ref(false);
const notice = ref("");
const error = ref("");

function apply(raw: unknown) {
  const source =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const str = (value: unknown, fallback: string) =>
    typeof value === "string" ? value : fallback;
  config.value = {
    type: str(source.type, DEFAULTS.type),
    retrieveUrl: str(source.retrieveUrl, DEFAULTS.retrieveUrl),
    authMode:
      source.authMode === "bearer" || source.authMode === "header"
        ? source.authMode
        : "none",
    authHeader: str(source.authHeader, DEFAULTS.authHeader),
    authValue: str(source.authValue, DEFAULTS.authValue),
    requestMapping: str(source.requestMapping, DEFAULTS.requestMapping),
    responseMapping: str(source.responseMapping, DEFAULTS.responseMapping),
    adminUrl: str(source.adminUrl, DEFAULTS.adminUrl),
  };
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    rawSettings.value = await readPipelineSettings();
    apply(rawSettings.value.knowledgeConnector);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "连接器配置加载失败";
  } finally {
    loading.value = false;
  }
}

function applyTemplate() {
  if (!window.confirm("用 WeKnora 预设模板覆盖当前表单？")) return;
  config.value = { ...WEKNORA_TEMPLATE };
  notice.value = "已填充 WeKnora 预设模板（保存后生效）";
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  notice.value = "";
  error.value = "";
  try {
    for (const field of ["requestMapping", "responseMapping"] as const) {
      const text = config.value[field].trim();
      if (text) JSON.parse(text);
    }
  } catch {
    error.value = "字段映射不是合法 JSON，请修正后再保存";
    saving.value = false;
    return;
  }
  try {
    await writePipelineSettings({
      ...rawSettings.value,
      knowledgeConnector: { ...config.value },
    });
    notice.value = "已保存；30 秒内生效（无需重启）";
  } catch (reason) {
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
        <strong>知识库连接器</strong>
        <span class="spacer" />
        <button class="wf-button compact" @click="applyTemplate">
          填充 WeKnora 预设
        </button>
        <span v-if="notice" class="wf-settings-notice">{{ notice }}</span>
        <span v-if="error" class="wf-settings-error">{{ error }}</span>
      </div>
      <div v-if="loading" class="wf-settings-body">
        <span class="wf-skeleton">正在加载连接器配置…</span>
      </div>
      <div v-else class="wf-settings-body">
        <p class="wf-settings-hint">
          通用 RESTful 连接器：AI 检索时按下方端点与字段映射调用外部知识库。
          知识库内容管理（上传/文档/分块）请使用外部知识库原生界面（会话工作台的
          「知识库」页为只读验证视图）。
        </p>
        <div class="wf-form-row">
          <label>
            <strong>连接器类型</strong>
            <span>标识用途；weknora 为预设模板。</span>
          </label>
          <input v-model="config.type" class="wf-input" placeholder="weknora / custom-rest" />
        </div>
        <div class="wf-form-row">
          <label>
            <strong>检索端点 URL</strong>
            <span>接收 {query, knowledgeBaseIds} 的 POST 端点；留空 = 不接外部知识库。</span>
          </label>
          <input v-model="config.retrieveUrl" class="wf-input" placeholder="https://kb.example.com/api/search" />
        </div>
        <div class="wf-form-row">
          <label>
            <strong>认证方式</strong>
          </label>
          <div class="wf-cap-row">
            <label class="wf-cap">
              <input v-model="config.authMode" type="radio" value="none" /> 无
            </label>
            <label class="wf-cap">
              <input v-model="config.authMode" type="radio" value="bearer" /> Bearer Token
            </label>
            <label class="wf-cap">
              <input v-model="config.authMode" type="radio" value="header" /> 自定义 Header
            </label>
          </div>
        </div>
        <div v-if="config.authMode === 'header'" class="wf-form-row">
          <label><strong>Header 名</strong></label>
          <input v-model="config.authHeader" class="wf-input" placeholder="X-Api-Key" />
        </div>
        <div v-if="config.authMode !== 'none'" class="wf-form-row">
          <label><strong>凭据</strong><span>保存后不回显；留空保持原值。</span></label>
          <input v-model="config.authValue" type="password" class="wf-input" placeholder="留空保持不变" />
        </div>
        <div class="wf-form-row">
          <label>
            <strong>请求字段映射 JSON</strong>
            <span>本地查询 → 上游请求体（JSONPath 风格声明）。</span>
          </label>
          <textarea v-model="config.requestMapping" rows="2" class="wf-input" />
        </div>
        <div class="wf-form-row">
          <label>
            <strong>响应字段映射 JSON</strong>
            <span>上游响应 → 本地证据结构。</span>
          </label>
          <textarea v-model="config.responseMapping" rows="2" class="wf-input" />
        </div>
        <div class="wf-form-row">
          <label>
            <strong>管理端点 URL（可选）</strong>
            <span>RESTful 管理接口；当前版本仅登记，不在界面内管理内容。</span>
          </label>
          <input v-model="config.adminUrl" class="wf-input" placeholder="https://kb.example.com/api" />
        </div>
        <div class="wf-form-actions">
          <button class="wf-button primary" :disabled="saving" @click="save">
            {{ saving ? "保存中…" : "保存连接器" }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
@import "./settings-shared.css";
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
</style>
