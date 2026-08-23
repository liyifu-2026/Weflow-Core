<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { api } from "../api";
import type { SettingField } from "../stores/extensions";

const props = defineProps<{
  solutionId: string;
  extensionId: string;
  schema: SettingField[];
}>();

const values = reactive<Record<string, any>>({});
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const notice = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const data = await api<{ settings: Record<string, unknown> }>(
      `/api/v1/admin/solutions/${encodeURIComponent(props.solutionId)}/extensions/${encodeURIComponent(props.extensionId)}/settings`,
    );
    for (const field of props.schema) {
      values[field.key] =
        data.settings[field.key] ??
        field.default ??
        (field.type === "boolean" ? false : "");
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "加载设置失败";
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    const payload: Record<string, unknown> = {};
    for (const field of props.schema) {
      payload[field.key] = values[field.key];
    }
    const result = await api<{ settings: Record<string, unknown> }>(
      `/api/v1/admin/solutions/${encodeURIComponent(props.solutionId)}/extensions/${encodeURIComponent(props.extensionId)}/settings`,
      { method: "PUT", body: JSON.stringify({ settings: payload }) },
    );
    notice.value = "设置已保存";
    for (const field of props.schema) {
      values[field.key] = result.settings[field.key] ?? values[field.key];
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "保存失败";
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="wf-setting-form">
    <div v-if="loading" class="wf-panel-body">
      <span class="wf-skeleton">正在加载设置…</span>
    </div>
    <template v-else>
      <div v-if="error" class="wf-error" role="alert">{{ error }}</div>
      <div v-if="notice" class="wf-notice" role="status">{{ notice }}</div>
      <label v-for="field in schema" :key="field.key" class="wf-field">
        <span>{{ field.label }}</span>
        <input
          v-if="field.type === 'text' || field.type === 'secret'"
          v-model="values[field.key]"
          :type="field.type === 'secret' ? 'password' : 'text'"
          :placeholder="field.placeholder"
          class="wf-input"
        />
        <textarea
          v-else-if="field.type === 'textarea'"
          v-model="values[field.key]"
          class="wf-input"
          rows="3"
          :placeholder="field.placeholder"
        ></textarea>
        <input
          v-else-if="field.type === 'number'"
          v-model.number="values[field.key]"
          type="number"
          class="wf-input"
        />
        <label v-else-if="field.type === 'boolean'" class="wf-checkbox">
          <input v-model="values[field.key]" type="checkbox" />
          <span>{{ field.label }}</span>
        </label>
        <select
          v-else-if="field.type === 'select'"
          v-model="values[field.key]"
          class="wf-input wf-select"
        >
          <option
            v-for="option in field.options"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
      </label>
      <div class="wf-actions">
        <button
          class="wf-button primary compact"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? "保存中…" : "保存设置" }}
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.wf-setting-form {
  padding: 12px;
}
.wf-setting-form .wf-field {
  margin-bottom: 12px;
}
.wf-setting-form .wf-actions {
  margin-top: 8px;
}
.wf-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
</style>
