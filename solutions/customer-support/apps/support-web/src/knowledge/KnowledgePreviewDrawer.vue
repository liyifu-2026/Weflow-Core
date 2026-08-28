<script setup lang="ts">
import { confirmDialog } from "../components/confirm-dialog";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useWeflowAuthStore } from "../auth-store";
import WfInspector from "../components/WfInspector.vue";
import { renderMiniMarkdown } from "./mini-markdown";
import type { NavigationOrigin } from "../navigation-context";
import { returnToOrigin } from "../navigation-context";
import { useKnowledgeWorkspaceStore } from "../stores/knowledge-workspace";
import {
  getKnowledgeSpans,
  listChunks,
  listChunkRevisions,
  previewKnowledgeFile,
  regenerateGeneratedQuestions,
  revertDocumentChunk,
  updateChunk,
  upsertGeneratedQuestion,
  type Chunk,
  type ChunkRevision,
  type KnowledgeDocument,
} from "./api";

const props = defineProps<{
  document: KnowledgeDocument;
  kbId?: string;
  origin: NavigationOrigin;
  initialChunkId?: string;
}>();
const emit = defineEmits<{ close: []; changed: []; revalidate: [] }>();

const auth = useWeflowAuthStore();
const router = useRouter();
const docId = computed(() =>
  String(props.document.id ?? props.document.knowledge_id ?? ""),
);

const previewText = ref("");
const previewHtml = ref("");
const previewUrl = ref("");
const previewType = ref("");
const previewLoading = ref(false);
const previewError = ref("");
/** 上游仅提供原始二进制（PPTX/DOCX 等）时：原始预览不可用，展示已解析文本 */
const parsedFallback = ref(false);
let objectUrl: string | null = null;

// View state machine — one surface, no drawer-in-drawer.
const view = ref<"preview" | "chunks">(
  props.initialChunkId ? "chunks" : "preview",
);
const chunks = ref<Chunk[]>([]);
const chunksLoading = ref(false);
const chunksError = ref("");
const selectedChunkId = ref(props.initialChunkId ?? "");
const editingContent = ref("");
const editingEnabled = ref(true);
const saving = ref(false);
const newQuestion = ref("");
const questionBusy = ref(false);
const revisionsOpen = ref(false);

const revisions = ref<ChunkRevision[]>([]);
const revisionsLoading = ref(false);
const traceOpen = ref(false);
const trace = ref<Array<Record<string, unknown>>>([]);
const traceLoading = ref(false);

const selectedChunk = computed(() =>
  chunks.value.find((item) => chunkId(item) === selectedChunkId.value),
);
const chunkId = (item: Chunk) => String(item.chunk_id ?? item.id ?? "");

const title = computed(
  () =>
    props.document.title ||
    props.document.name ||
    props.document.file_name ||
    props.document.filename ||
    "未命名内容",
);
const sourceLabel = computed(
  () => props.document.source_type || props.document.type || "文档",
);

async function loadPreview() {
  if (!docId.value) return;
  previewLoading.value = true;
  previewError.value = "";
  try {
    const { blob, contentType } = await previewKnowledgeFile(docId.value);
    previewType.value = contentType.split(";")[0].trim();
    if (
      contentType.includes("text") ||
      contentType.includes("markdown") ||
      contentType.includes("json") ||
      contentType.includes("xml") ||
      contentType.includes("csv")
    ) {
      const raw = await blob.text();
      if (contentType.includes("markdown")) {
        // Markdown 用统一阅读体验渲染（#18），不是浏览器默认样式。
        previewHtml.value = renderMiniMarkdown(raw);
        previewText.value = "";
      } else {
        previewText.value = raw;
      }
    } else if (contentType.includes("pdf")) {
      objectUrl = URL.createObjectURL(blob);
      previewUrl.value = objectUrl;
    } else {
      // 上游对二进制格式（PPTX/DOCX 等）只回原始文件，无转换预览。
      // 降级：明确说明原始预览不可用，已解析内容仍可阅读（chunks）。
      previewText.value = "";
      parsedFallback.value = true;
      void loadChunks();
    }
  } catch (reason) {
    previewError.value =
      reason instanceof Error ? reason.message : "预览加载失败";
  } finally {
    previewLoading.value = false;
  }
}

async function loadChunks() {
  if (!docId.value) return;
  chunksLoading.value = true;
  chunksError.value = "";
  try {
    chunks.value = await listChunks(docId.value, 1, 100);
    if (!selectedChunkId.value && chunks.value[0]) {
      selectChunk(chunks.value[0]);
    }
  } catch (reason) {
    chunksError.value =
      reason instanceof Error ? reason.message : "切片加载失败";
  } finally {
    chunksLoading.value = false;
  }
}

function selectChunk(item: Chunk) {
  selectedChunkId.value = chunkId(item);
  editingContent.value = item.content ?? "";
  editingEnabled.value = item.is_enabled !== false;
}

async function saveChunk(revalidate: boolean) {
  if (!docId.value || !selectedChunkId.value) return;
  saving.value = true;
  chunksError.value = "";
  try {
    await updateChunk(docId.value, selectedChunkId.value, {
      content: editingContent.value,
      expected_revision: selectedChunk.value?.content_revision ?? undefined,
      is_enabled: editingEnabled.value,
    });
    emit("changed");
    await loadChunks();
    if (revalidate) {
      const workspaceKey =
        props.origin.type === "conversation"
          ? `${auth.user?.userId}:conversation:${props.origin.conversationId}`
          : `${auth.user?.userId}:standalone`;
      const question = useKnowledgeWorkspaceStore().open(workspaceKey).question;
      if (question.trim()) emit("revalidate");
    }
  } catch (reason) {
    chunksError.value =
      reason instanceof Error ? reason.message : "切片保存失败";
  } finally {
    saving.value = false;
  }
}

async function addQuestion() {
  if (!selectedChunkId.value || !newQuestion.value.trim()) return;
  questionBusy.value = true;
  chunksError.value = "";
  try {
    await upsertGeneratedQuestion(selectedChunkId.value, {
      question: newQuestion.value.trim(),
    });
    newQuestion.value = "";
    await loadChunks();
  } catch (reason) {
    chunksError.value =
      reason instanceof Error ? reason.message : "问题保存失败";
  } finally {
    questionBusy.value = false;
  }
}

async function regenerateQuestions() {
  if (!selectedChunkId.value) return;
  questionBusy.value = true;
  chunksError.value = "";
  try {
    await regenerateGeneratedQuestions(selectedChunkId.value);
    await loadChunks();
  } catch (reason) {
    chunksError.value =
      reason instanceof Error ? reason.message : "问题生成失败";
  } finally {
    questionBusy.value = false;
  }
}

async function openRevisions() {
  if (!docId.value || !selectedChunkId.value) return;
  revisionsOpen.value = !revisionsOpen.value;
  if (!revisionsOpen.value) return;
  revisionsLoading.value = true;
  revisions.value = [];
  try {
    revisions.value = await listChunkRevisions(docId.value, selectedChunkId.value);
  } catch (reason) {
    chunksError.value =
      reason instanceof Error ? reason.message : "版本历史加载失败";
  } finally {
    revisionsLoading.value = false;
  }
}

async function revertTo(revision: ChunkRevision) {
  if (!docId.value || !selectedChunkId.value) return;
  if (
    !await confirmDialog(
      `回滚到此版本（revision ${revision.content_revision}）？当前修改将被替换。`,
    )
  )
    return;
  try {
    await revertDocumentChunk(docId.value, selectedChunkId.value, {
      revision: revision.content_revision ?? 0,
    });
    revisionsOpen.value = false;
    await loadChunks();
    emit("changed");
  } catch (reason) {
    chunksError.value = reason instanceof Error ? reason.message : "回滚失败";
  }
}

async function openTrace() {
  if (!docId.value) return;
  traceOpen.value = !traceOpen.value;
  if (!traceOpen.value) return;
  traceLoading.value = true;
  trace.value = [];
  try {
    trace.value = await getKnowledgeSpans(docId.value);
  } catch {
    trace.value = [];
  } finally {
    traceLoading.value = false;
  }
}

function backToOrigin() {
  if (props.origin.type !== "standalone") {
    void returnToOrigin(router, props.origin);
    return;
  }
  emit("close");
}

watch(
  () => props.initialChunkId,
  (value) => {
    if (typeof value === "string" && value) {
      selectedChunkId.value = value;
      const target = chunks.value.find((item) => chunkId(item) === value);
      if (target) selectChunk(target);
      view.value = "chunks";
    }
  },
  { immediate: true },
);

onMounted(() => {
  void loadPreview();
  if (auth.isAdmin && view.value === "chunks") void loadChunks();
});
onUnmounted(() => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});
</script>

<template>
  <WfInspector
    variant="overlay"
    :open="true"
    :title="title"
    :depth="view === 'chunks' ? 1 : 0"
    @back="view = 'preview'"
    @close="emit('close')"
  >
    <template #actions>
      <details v-if="view === 'preview' && auth.isAdmin" class="wf-row-menu">
        <summary class="wf-icon-button" title="更多">···</summary>
        <div>
          <button @click="openTrace">处理详情</button>
        </div>
      </details>
      <button
        v-if="origin.type !== 'standalone'"
        class="wf-button compact"
        @click="backToOrigin"
      >
        返回会话
      </button>
    </template>

    <template v-if="view === 'preview'">
      <div class="wf-preview-surface">
        <p class="wf-preview-meta">
          {{ sourceLabel }} · {{ document.updated_at ? new Date(document.updated_at).toLocaleString() : "—" }}
        </p>
        <div v-if="previewError" class="wf-error">{{ previewError }}</div>
        <div v-if="previewLoading" class="wf-skeleton wf-skeleton-title"></div>
        <article
          v-else-if="previewHtml"
          class="wf-wiki-content"
          v-html="previewHtml"
        ></article>
        <pre v-else-if="previewText" class="wf-doc-preview">{{ previewText }}</pre>
        <iframe
          v-else-if="previewUrl"
          class="wf-doc-frame"
          :src="previewUrl"
          title="文档预览"
        ></iframe>
        <div v-else-if="parsedFallback" class="wf-preview-fallback">
          <div class="wf-preview-fallback-head">
            <strong>原始预览不可用</strong>
            <span class="wf-muted">该格式仅提供原始文件，已解析内容仍可阅读。</span>
          </div>
          <div v-if="chunksLoading" class="wf-skeleton wf-skeleton-title"></div>
          <div v-else-if="chunks.length" class="wf-fallback-chunks">
            <p class="wf-fallback-chunk">{{ chunks[0].content }}</p>
            <button
              class="wf-link wf-link-button"
              @click="view = 'chunks'; loadChunks()"
            >
              查看全部 {{ chunks.length }} 个切片 →
            </button>
          </div>
          <div v-else class="wf-empty wf-empty-compact">
            <div>
              <strong>没有可展示的解析内容</strong>
              <p>该文件可能仍在解析，或解析结果不可用。</p>
            </div>
          </div>
        </div>
        <div v-else class="wf-empty wf-empty-compact">
          <div>
            <strong>暂不支持预览此格式</strong>
            <p>当前类型：{{ previewType || "未知" }}</p>
          </div>
        </div>

        <div v-if="traceOpen" class="wf-inline-section">
          <span class="wf-brief-label">处理详情</span>
          <div v-if="traceLoading" class="wf-skeleton wf-skeleton-title"></div>
          <div v-for="(span, index) in trace" :key="index" class="wf-trace-row">
            <span>{{ String(span.name ?? span.stage ?? "阶段") }}</span>
            <span class="wf-muted">{{ String(span.status ?? "") }}</span>
          </div>
          <div v-if="!traceLoading && !trace.length" class="wf-muted">
            没有可展示的处理过程。
          </div>
        </div>

        <div class="wf-preview-footer">
          <button
            v-if="auth.isAdmin"
            class="wf-link wf-link-button"
            @click="view = 'chunks'; loadChunks()"
          >
            {{ chunks.length ? `${chunks.length} 个切片` : "查看切片" }} →
          </button>
          <span v-else class="wf-muted">{{ chunks.length ? `${chunks.length} 个切片` : "" }}</span>
          <span class="wf-muted">{{ document.parse_status || document.status || "" }}</span>
        </div>
      </div>
    </template>

    <template v-else>
      <div>
        <div v-if="chunksError" class="wf-error">{{ chunksError }}</div>
        <div v-if="chunksLoading" class="wf-skeleton wf-skeleton-title"></div>
        <template v-else>
          <div class="wf-chunk-list wf-chunk-list-drawer">
            <div
              v-for="item in chunks"
              :key="chunkId(item)"
              class="wf-chunk-row"
              :class="{
                selected: selectedChunkId === chunkId(item),
                'wf-target-highlight': selectedChunkId === chunkId(item),
              }"
              @click="selectChunk(item)"
            >
              <span class="wf-mono wf-subtle">{{ chunkId(item).slice(0, 12) }}</span>
              <p>{{ item.content || "空切片" }}</p>
              <span
                v-if="item.parent_chunk_id"
                class="wf-subtle wf-chunk-parent"
                title="父切片"
                >parent {{ item.parent_chunk_id.slice(0, 8) }}</span
              >
            </div>
            <div v-if="!chunks.length" class="wf-empty wf-empty-compact">
              <div>
                <strong>未返回可编辑切片</strong>
                <p>上游没有提供切片列表。</p>
              </div>
            </div>
          </div>
          <div v-if="selectedChunk" class="wf-chunk-editor">
            <span class="wf-brief-label">修正切片</span>
            <textarea
              v-model="editingContent"
              class="wf-textarea"
              rows="7"
            ></textarea>
            <label class="wf-checkbox-row">
              <input v-model="editingEnabled" type="checkbox" />启用此切片
            </label>
            <div class="wf-actions">
              <button
                class="wf-button compact"
                :disabled="saving"
                @click="saveChunk(false)"
              >
                {{ saving ? "保存中" : "保存" }}
              </button>
              <button
                class="wf-button compact primary"
                :disabled="saving"
                @click="saveChunk(true)"
              >
                保存并重新验证
              </button>
              <button
                class="wf-button compact"
                :disabled="questionBusy"
                @click="openRevisions"
              >
                {{ revisionsOpen ? "收起版本" : "版本历史" }}
              </button>
            </div>

            <div v-if="revisionsOpen" class="wf-inline-section">
              <span class="wf-brief-label">版本历史</span>
              <div v-if="revisionsLoading" class="wf-skeleton wf-skeleton-title"></div>
              <div
                v-for="revision in revisions"
                :key="revision.content_revision"
                class="wf-revision-row"
              >
                <div>
                  <strong>revision {{ revision.content_revision }}</strong>
                  <span class="wf-muted">
                    {{ revision.created_at ? new Date(revision.created_at).toLocaleString() : "" }}
                  </span>
                </div>
                <p>{{ revision.content || "空切片" }}</p>
                <button class="wf-button compact" @click="revertTo(revision)">
                  回滚到此版本
                </button>
              </div>
              <div v-if="!revisionsLoading && !revisions.length" class="wf-muted">
                没有版本记录。
              </div>
            </div>

            <template v-if="(selectedChunk.generated_questions?.length || 0) > 0">
              <span class="wf-brief-label">已生成问题</span>
              <ul class="wf-question-list">
                <li
                  v-for="(item, index) in selectedChunk.generated_questions"
                  :key="index"
                >
                  {{ item.question }}
                </li>
              </ul>
            </template>
            <div class="wf-question-form">
              <input
                v-model="newQuestion"
                class="wf-input"
                placeholder="添加生成问题…"
                @keyup.enter="addQuestion"
              />
              <button
                class="wf-button compact"
                :disabled="questionBusy || !newQuestion.trim()"
                @click="addQuestion"
              >
                添加
              </button>
              <button
                class="wf-button compact"
                :disabled="questionBusy"
                @click="regenerateQuestions"
              >
                重新生成
              </button>
            </div>
          </div>
        </template>
      </div>
    </template>
  </WfInspector>
</template>

