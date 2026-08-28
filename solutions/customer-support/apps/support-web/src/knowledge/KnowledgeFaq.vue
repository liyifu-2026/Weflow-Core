<script setup lang="ts">
import { confirmDialog } from "../components/confirm-dialog";
import { onMounted, ref } from "vue";
import { useEscClose } from "../composables/use-esc-close";
import {
  createFAQEntry,
  deleteFAQEntries,
  listFAQEntries,
  updateFAQEntry,
  type FAQEntry,
} from "./api";

const props = defineProps<{ kbId: string }>();
const emit = defineEmits<{ error: [string] }>();

const entries = ref<FAQEntry[]>([]);
const loading = ref(false);
const keyword = ref("");
const editOpen = ref(false);
useEscClose(editOpen, () => { editOpen.value = false; });
const editing = ref<FAQEntry | null>(null);
const question = ref("");
const answer = ref("");
const similar = ref("");
const submitting = ref(false);

const entryId = (item: FAQEntry) => String(item.id ?? item.faq_id ?? "");
const entryQuestion = (item: FAQEntry) =>
  item.question || item.standard_question || "未命名问题";

async function load() {
  if (!props.kbId) return;
  loading.value = true;
  try {
    entries.value = await listFAQEntries(props.kbId, {
      keyword: keyword.value.trim() || undefined,
      page_size: 100,
    });
  } catch (reason) {
    emit(
      "error",
      reason instanceof Error ? reason.message : "FAQ 加载失败",
    );
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  question.value = "";
  answer.value = "";
  similar.value = "";
  editOpen.value = true;
}

function openEdit(item: FAQEntry) {
  editing.value = item;
  question.value = entryQuestion(item);
  answer.value = item.answer ?? "";
  similar.value = (item.similar_questions ?? []).join("\n");
  editOpen.value = true;
}

async function save() {
  if (!props.kbId || !question.value.trim()) return;
  submitting.value = true;
  try {
    const payload = {
      question: question.value.trim(),
      answer: answer.value,
      similar_questions: similar.value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    };
    if (editing.value) {
      await updateFAQEntry(props.kbId, entryId(editing.value), payload);
    } else {
      await createFAQEntry(props.kbId, payload);
    }
    editOpen.value = false;
    await load();
  } catch (reason) {
    emit("error", reason instanceof Error ? reason.message : "FAQ 保存失败");
  } finally {
    submitting.value = false;
  }
}

async function toggleEnabled(item: FAQEntry) {
  try {
    await updateFAQEntry(props.kbId, entryId(item), {
      is_enabled: item.is_enabled === false,
    });
    await load();
  } catch (reason) {
    emit("error", reason instanceof Error ? reason.message : "更新失败");
  }
}

async function remove(item: FAQEntry) {
  if (!await confirmDialog(`删除 FAQ「${entryQuestion(item)}」？`)) return;
  try {
    await deleteFAQEntries(props.kbId, [entryId(item)]);
    await load();
  } catch (reason) {
    emit("error", reason instanceof Error ? reason.message : "删除失败");
  }
}

onMounted(load);
</script>

<template>
  <div class="wf-content-workspace">
    <div class="wf-content-toolbar">
      <div class="wf-search">
        <input
          v-model="keyword"
          class="wf-input"
          placeholder="搜索 FAQ…"
          @keyup.enter="load()"
        />
      </div>
      <div class="wf-spacer"></div>
      <button class="wf-button primary" @click="openCreate">添加 FAQ</button>
    </div>
    <section class="wf-content-list">
      <template v-if="loading">
        <div v-for="i in 4" :key="i" class="wf-content-row">
          <div class="wf-skeleton wf-skeleton-title"></div>
        </div>
      </template>
      <template v-else>
        <div v-for="item in entries" :key="entryId(item)" class="wf-faq-row">
          <div class="wf-content-name">
            <strong>{{ entryQuestion(item) }}</strong>
            <span class="wf-muted">{{ item.answer || "无答案" }}</span>
          </div>
          <span class="wf-faq-state">
            <span v-if="item.is_enabled === false" class="wf-status inactive"
              >已停用</span
            >
            <span v-else-if="item.is_recommended" class="wf-muted"
              >· 推荐</span
            >
          </span>
          <details class="wf-row-menu wf-content-menu">
            <summary class="wf-icon-button" title="更多操作">···</summary>
            <div>
              <button @click="openEdit(item)">编辑</button>
              <button @click="toggleEnabled(item)">{{
                item.is_enabled === false ? "启用" : "停用"
              }}</button>
              <button class="danger" @click="remove(item)">删除</button>
            </div>
          </details>
        </div>
        <div v-if="!entries.length" class="wf-empty">
          <div>
            <strong>还没有 FAQ</strong>
            <p>添加标准问题与答案，Agent 会优先使用 FAQ 回答。</p>
          </div>
        </div>
      </template>
    </section>

    <div v-if="editOpen" class="wf-modal-mask" @click.self="editOpen = false">
      <div class="wf-modal">
        <div class="wf-modal-head">
          <h3>{{ editing ? "编辑 FAQ" : "添加 FAQ" }}</h3>
          <button class="wf-icon-button" @click="editOpen = false">×</button>
        </div>
        <div class="wf-modal-body">
          <div class="wf-field">
            <label>标准问题</label>
            <input v-model="question" class="wf-input" />
          </div>
          <div class="wf-field">
            <label>答案</label>
            <textarea v-model="answer" class="wf-textarea" rows="5"></textarea>
          </div>
          <div class="wf-field">
            <label>相似问题（每行一条）</label>
            <textarea
              v-model="similar"
              class="wf-textarea"
              rows="3"
              placeholder="客户可能换一种问法…"
            ></textarea>
          </div>
        </div>
        <div class="wf-modal-foot">
          <button class="wf-button" @click="editOpen = false">取消</button>
          <button
            class="wf-button primary"
            :disabled="submitting || !question.trim()"
            @click="save"
          >
            {{ submitting ? "保存中" : "保存" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

