<script setup lang="ts">
import { confirmDialog } from "../components/confirm-dialog";
import { computed, onMounted, ref } from "vue";
import WfInspector from "../components/WfInspector.vue";
import { useEscClose } from "../composables/use-esc-close";
import {
  createWikiPage,
  deleteWikiPage,
  getWikiPage,
  listWikiPages,
  updateWikiPage,
  type WikiPage,
} from "./api";
import { renderMiniMarkdown } from "./mini-markdown";

const props = defineProps<{ kbId: string }>();
const emit = defineEmits<{ error: [string] }>();

const pages = ref<WikiPage[]>([]);
const loading = ref(false);
const reading = ref<WikiPage | null>(null);
useEscClose(computed(() => Boolean(reading.value) || editOpen.value), () => {
  reading.value = null;
  editOpen.value = false;
});
const readingHtml = ref("");
const editOpen = ref(false);
const editing = ref<WikiPage | null>(null);
const title = ref("");
const content = ref("");
const submitting = ref(false);

const pageSlug = (item: WikiPage) => String(item.slug ?? "");

// 树形展示：上游无 tree 端点，wiki_path 本身是层级事实（"index/Install/…"）。
const pageDepth = (item: WikiPage) => {
  const path = String(item.wiki_path ?? "");
  return path ? path.split("/").length - 1 : 0;
};

async function load() {
  if (!props.kbId) return;
  loading.value = true;
  try {
    pages.value = await listWikiPages(props.kbId);
  } catch (reason) {
    emit("error", reason instanceof Error ? reason.message : "Wiki 加载失败");
  } finally {
    loading.value = false;
  }
}

async function openRead(item: WikiPage) {
  if (!props.kbId || !pageSlug(item)) return;
  try {
    const page = await getWikiPage(props.kbId, pageSlug(item));
    reading.value = page;
    readingHtml.value = renderMiniMarkdown(page.content ?? "");
  } catch (reason) {
    emit("error", reason instanceof Error ? reason.message : "页面加载失败");
  }
}

function openCreate() {
  editing.value = null;
  title.value = "";
  content.value = "";
  editOpen.value = true;
}

function openEdit(item: WikiPage) {
  editing.value = item;
  title.value = item.title ?? "";
  content.value = item.content ?? "";
  editOpen.value = true;
}

async function save() {
  if (!props.kbId || !title.value.trim()) return;
  submitting.value = true;
  try {
    if (editing.value) {
      await updateWikiPage(props.kbId, pageSlug(editing.value), {
        title: title.value.trim(),
        content: content.value,
        version: editing.value.version,
      });
    } else {
      await createWikiPage(props.kbId, {
        title: title.value.trim(),
        content: content.value,
      });
    }
    editOpen.value = false;
    await load();
  } catch (reason) {
    emit("error", reason instanceof Error ? reason.message : "保存失败");
  } finally {
    submitting.value = false;
  }
}

async function remove(item: WikiPage) {
  if (!props.kbId || !pageSlug(item)) return;
  if (!await confirmDialog(`删除 Wiki 页面「${item.title}」？`)) return;
  try {
    await deleteWikiPage(props.kbId, pageSlug(item));
    if (reading.value?.slug === item.slug) reading.value = null;
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
      <span class="wf-section-caption">Wiki 页面</span>
      <div class="wf-spacer"></div>
      <button class="wf-button primary" @click="openCreate">新建页面</button>
    </div>
    <section class="wf-content-list">
      <template v-if="loading">
        <div v-for="i in 4" :key="i" class="wf-content-row">
          <div class="wf-skeleton wf-skeleton-title"></div>
        </div>
      </template>
      <template v-else>
        <div
          v-for="item in pages"
          :key="pageSlug(item)"
          class="wf-wiki-row"
          :style="{ paddingLeft: 12 + pageDepth(item) * 20 + 'px' }"
        >
          <button class="wf-content-name" @click="openRead(item)">
            <strong>{{ item.title || pageSlug(item) }}</strong>
            <span class="wf-muted"
              >{{ item.page_type || "页面" }} · v{{
                item.version ?? "—"
              }}</span
            >
          </button>
          <span class="wf-muted wf-content-time">{{
            item.updated_at
              ? new Date(item.updated_at).toLocaleDateString()
              : "—"
          }}</span>
          <details class="wf-row-menu wf-content-menu">
            <summary class="wf-icon-button" title="更多操作">···</summary>
            <div>
              <button @click="openEdit(item)">编辑</button>
              <button class="danger" @click="remove(item)">删除</button>
            </div>
          </details>
        </div>
        <div v-if="!pages.length" class="wf-empty">
          <div>
            <strong>还没有 Wiki 页面</strong>
            <p>创建第一份 Wiki 页面，建立可追溯的组织知识。</p>
          </div>
        </div>
      </template>
    </section>

    <WfInspector
      variant="overlay"
      :open="Boolean(reading)"
      :title="reading?.title ?? ''"
      @close="reading = null"
    >
      <template #actions>
        <button v-if="reading" class="wf-button compact" @click="openEdit(reading)">
          编辑
        </button>
      </template>
      <template v-if="reading">
        <p class="wf-muted wf-wiki-meta">
          {{ reading.page_type || "页面" }} · v{{ reading.version ?? "—" }} ·
          {{
            reading.updated_at
              ? new Date(reading.updated_at).toLocaleString()
              : "—"
          }}
        </p>
        <article class="wf-wiki-content" v-html="readingHtml"></article>
      </template>
    </WfInspector>

    <div v-if="editOpen" class="wf-modal-mask" @click.self="editOpen = false">
      <div class="wf-modal">
        <div class="wf-modal-head">
          <h3>{{ editing ? "编辑页面" : "新建页面" }}</h3>
          <button class="wf-icon-button" @click="editOpen = false">×</button>
        </div>
        <div class="wf-modal-body">
          <div class="wf-field">
            <label>标题</label>
            <input v-model="title" class="wf-input" />
          </div>
          <div class="wf-field">
            <label>内容（Markdown）</label>
            <textarea
              v-model="content"
              class="wf-textarea"
              rows="12"
              placeholder="# 标题&#10;&#10;正文…"
            ></textarea>
          </div>
        </div>
        <div class="wf-modal-foot">
          <button class="wf-button" @click="editOpen = false">取消</button>
          <button
            class="wf-button primary"
            :disabled="submitting || !title.trim()"
            @click="save"
          >
            {{ submitting ? "保存中" : "保存" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

