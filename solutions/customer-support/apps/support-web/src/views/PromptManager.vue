<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  getPrompts,
  savePrompts,
  type PromptMap,
} from "../settings/api";

const loading = ref(false);
const saving = ref(false);
const error = ref("");
const notice = ref("");
const data = ref<PromptMap>({
  default: null,
  contacts: {},
  conversations: {},
});

const newKey = ref("");
const newValue = ref("");
const newScope = ref<"contacts" | "conversations">("contacts");

function setDefaultPrompt(value: string) {
  data.value.default = value.trim() ? value : null;
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    data.value = await getPrompts();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "加载失败";
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    data.value = await savePrompts(data.value);
    notice.value = "已保存，Agent 下次构建上下文时生效";
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "保存失败";
  } finally {
    saving.value = false;
  }
}

function addMapping() {
  const key = newKey.value.trim();
  const value = newValue.value.trim();
  if (!key || !value) return;
  data.value[newScope.value][key] = value;
  newKey.value = "";
  newValue.value = "";
}

function removeMapping(scope: "contacts" | "conversations", key: string) {
  delete data.value[scope][key];
  data.value = { ...data.value };
}

onMounted(load);
</script>

<template>
  <div class="prompt-manager">
    <header class="wf-page-head">
      <div>
        <p class="pm-eyebrow">Prompt 配置</p>
        <h1>客服提示词</h1>
        <p>为默认客服、指定联系人或指定会话配置独立 Prompt。</p>
      </div>
      <button
        class="wf-button primary compact"
        :disabled="saving || loading"
        @click="save"
      >
        {{ saving ? "保存中…" : "保存" }}
      </button>
    </header>

    <div v-if="error" class="wf-error">{{ error }}</div>
    <div v-if="notice" class="wf-notice">{{ notice }}</div>
    <div v-if="loading" class="wf-muted">加载中…</div>

    <template v-else>
      <section class="pm-section">
        <div class="pm-section-head">
          <div>
            <strong>默认 Prompt</strong>
            <span>留空则使用内置客服 Prompt</span>
          </div>
          <span class="pm-badge">全局</span>
        </div>
        <div class="pm-section-body">
          <textarea
            class="wf-textarea"
            rows="6"
            placeholder="留空则使用内置客服 Prompt"
            :value="data.default ?? ''"
            @input="setDefaultPrompt(($event.target as HTMLTextAreaElement).value)"
          ></textarea>
        </div>
      </section>

      <section class="pm-section">
        <div class="pm-section-head">
          <div>
            <strong>新增映射</strong>
            <span>联系人键或会话键 → 专属 Prompt</span>
          </div>
        </div>
        <div class="pm-section-body">
          <div class="pm-mapping-form">
            <select v-model="newScope" class="wf-select">
              <option value="contacts">联系人</option>
              <option value="conversations">会话</option>
            </select>
            <input
              v-model="newKey"
              class="wf-input"
              :placeholder="
                newScope === 'contacts'
                  ? 'contact:channel:wxid_xxx'
                  : 'channel:xxx'
              "
            />
            <textarea
              v-model="newValue"
              class="wf-textarea pm-value-input"
              rows="2"
              placeholder="该客户/会话使用的 Prompt"
            ></textarea>
            <button class="wf-button compact" @click="addMapping">添加</button>
          </div>
        </div>
      </section>

      <section class="pm-section">
        <div class="pm-section-head">
          <div>
            <strong>联系人 Prompt</strong>
            <span>按联系人键覆盖默认 Prompt</span>
          </div>
          <span class="pm-badge">{{ Object.keys(data.contacts).length }}</span>
        </div>
        <div class="pm-section-body">
          <div v-if="Object.keys(data.contacts).length === 0" class="wf-muted">
            暂无联系人级 Prompt
          </div>
          <div
            v-for="(value, key) in data.contacts"
            :key="'c-' + key"
            class="pm-mapping-row"
          >
            <code>{{ key }}</code>
            <textarea
              v-model="data.contacts[key]"
              class="wf-textarea"
              rows="2"
            ></textarea>
            <button
              class="wf-button compact pm-remove"
              @click="removeMapping('contacts', key)"
            >
              删除
            </button>
          </div>
        </div>
      </section>

      <section class="pm-section">
        <div class="pm-section-head">
          <div>
            <strong>会话 Prompt</strong>
            <span>按会话键覆盖默认 Prompt</span>
          </div>
          <span class="pm-badge">{{ Object.keys(data.conversations).length }}</span>
        </div>
        <div class="pm-section-body">
          <div v-if="Object.keys(data.conversations).length === 0" class="wf-muted">
            暂无会话级 Prompt
          </div>
          <div
            v-for="(value, key) in data.conversations"
            :key="'s-' + key"
            class="pm-mapping-row"
          >
            <code>{{ key }}</code>
            <textarea
              v-model="data.conversations[key]"
              class="wf-textarea"
              rows="2"
            ></textarea>
            <button
              class="wf-button compact pm-remove"
              @click="removeMapping('conversations', key)"
            >
              删除
            </button>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.prompt-manager {
  padding: 16px 24px 32px;
  max-width: none;
}
.pm-eyebrow {
  margin: 0 0 6px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
}
.pm-section {
  margin-bottom: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  overflow: hidden;
}
.pm-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-soft);
}
.pm-section-head > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pm-section-head strong {
  font-size: 14px;
}
.pm-section-head span {
  color: var(--text-secondary);
  font-size: 12px;
}
.pm-badge {
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 12px;
  font-weight: 700;
}
.pm-section-body {
  padding: 16px;
}
.pm-mapping-form {
  display: grid;
  grid-template-columns: 120px minmax(180px, 1fr) auto;
  gap: 8px;
  align-items: start;
}
.pm-value-input {
  grid-column: 1 / -1;
}
.pm-mapping-row {
  display: grid;
  grid-template-columns: minmax(180px, 0.8fr) 1fr auto;
  gap: 8px;
  align-items: start;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.pm-mapping-row:last-child {
  border-bottom: 0;
}
.pm-mapping-row code {
  padding: 8px 0;
  color: var(--text-secondary);
  font-size: 12px;
  word-break: break-all;
}
.pm-remove {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 35%, transparent);
}
</style>
