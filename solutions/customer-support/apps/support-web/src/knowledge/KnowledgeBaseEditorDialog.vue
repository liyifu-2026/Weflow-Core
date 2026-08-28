<script setup lang="ts">
import { confirmDialog } from "../components/confirm-dialog";
import { ref } from "vue";
import { useEscClose } from "../composables/use-esc-close";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  updateKnowledgeBase,
  type KnowledgeBase,
} from "./api";

const props = defineProps<{ base?: KnowledgeBase | null }>();
const emit = defineEmits<{ close: []; done: [] }>();

const name = ref(props.base?.name ?? "");
useEscClose(ref(true), () => emit("close"));
const description = ref(props.base?.description ?? "");
const type = ref<"document" | "faq">(props.base?.type ?? "document");
const submitting = ref(false);
const error = ref("");

async function save() {
  if (!name.value.trim()) return;
  submitting.value = true;
  error.value = "";
  try {
    if (props.base) {
      await updateKnowledgeBase(props.base.id, {
        name: name.value.trim(),
        description: description.value.trim(),
      });
    } else {
      await createKnowledgeBase({
        name: name.value.trim(),
        description: description.value.trim(),
        type: type.value,
      });
    }
    emit("done");
    emit("close");
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "保存失败";
  } finally {
    submitting.value = false;
  }
}

async function remove() {
  if (!props.base) return;
  if (
    !await confirmDialog(
      `删除知识库「${props.base.name}」？其中的内容会一并删除，该操作会被审计。`,
    )
  )
    return;
  submitting.value = true;
  error.value = "";
  try {
    await deleteKnowledgeBase(props.base.id);
    emit("done");
    emit("close");
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "删除失败";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="wf-modal-mask" @click.self="emit('close')">
    <div class="wf-modal">
      <div class="wf-modal-head">
        <h3>{{ base ? "知识库设置" : "新建知识库" }}</h3>
        <button class="wf-icon-button" @click="emit('close')">×</button>
      </div>
      <div class="wf-modal-body">
        <div v-if="error" class="wf-error">{{ error }}</div>
        <div class="wf-field">
          <label>名称</label>
          <input v-model="name" class="wf-input" placeholder="例如：产品售后手册" />
        </div>
        <div class="wf-field">
          <label>用途说明</label>
          <textarea
            v-model="description"
            class="wf-textarea"
            rows="3"
            placeholder="说明 Agent 应在什么问题下使用这里的资料"
          ></textarea>
        </div>
        <div v-if="!base" class="wf-field">
          <label>类型</label>
          <select v-model="type" class="wf-select">
            <option value="document">文档</option>
            <option value="faq">FAQ</option>
          </select>
        </div>
        <p v-if="base" class="wf-muted">
          解析、分块与模型等高级配置将在后续版本开放。
        </p>
      </div>
      <div class="wf-modal-foot">
        <button
          v-if="base"
          class="wf-button danger"
          :disabled="submitting"
          @click="remove"
        >
          删除知识库
        </button>
        <div class="wf-spacer"></div>
        <button class="wf-button" @click="emit('close')">取消</button>
        <button
          class="wf-button primary"
          :disabled="submitting || !name.trim()"
          @click="save"
        >
          {{ submitting ? "保存中" : base ? "保存" : "创建知识库" }}
        </button>
      </div>
    </div>
  </div>
</template>

