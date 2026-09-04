<script setup lang="ts">
import { confirmDialog } from "../components/confirm-dialog";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ArrowRight, Ellipsis } from "lucide-vue-next";
import { useWeflowAuthStore } from "../auth-store";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  <Sheet :open="true" @update:open="(value) => !value && emit('close')">
    <SheetContent side="right" class="flex w-full max-w-xl flex-col gap-0 overflow-y-auto sm:max-w-xl">
      <SheetHeader class="gap-1 text-left">
        <SheetTitle class="truncate pr-6">{{ title }}</SheetTitle>
        <SheetDescription class="sr-only">文档预览与切片编辑</SheetDescription>
        <div class="flex flex-wrap items-center gap-2">
          <Button
            v-if="view === 'chunks'"
            variant="ghost"
            size="sm"
            class="h-7 px-2"
            @click="view = 'preview'"
          >
            ← 返回预览
          </Button>
          <span class="text-xs text-muted-foreground">
            {{ sourceLabel }} ·
            {{ document.updated_at ? new Date(document.updated_at).toLocaleString() : "—" }}
          </span>
        </div>
      </SheetHeader>

      <div class="flex flex-1 flex-col gap-4 px-4 pb-6">
        <!-- 头部操作行 -->
        <div class="flex items-center gap-2">
          <Button
            v-if="origin.type !== 'standalone'"
            variant="outline"
            size="sm"
            @click="backToOrigin"
          >
            返回会话
          </Button>
          <div class="flex-1"></div>
          <DropdownMenu v-if="view === 'preview' && auth.isAdmin">
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon" title="更多">
                <Ellipsis class="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem @click="openTrace">处理详情</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <!-- 预览视图 -->
        <template v-if="view === 'preview'">
          <div v-if="previewError" class="text-sm text-destructive">{{ previewError }}</div>
          <Skeleton v-if="previewLoading" class="h-6 w-2/3" />
          <article
            v-else-if="previewHtml"
            class="md-body max-w-none"
            v-html="previewHtml"
          ></article>
          <pre
            v-else-if="previewText"
            class="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-4 font-mono text-xs leading-relaxed"
          >{{ previewText }}</pre>
          <iframe
            v-else-if="previewUrl"
            class="h-[60vh] w-full rounded-md border border-border"
            :src="previewUrl"
            title="文档预览"
          ></iframe>
          <div v-else-if="parsedFallback" class="space-y-3">
            <div class="rounded-md border border-dashed border-border p-4">
              <p class="text-sm font-medium">原始预览不可用</p>
              <p class="mt-1 text-sm text-muted-foreground">
                该格式仅提供原始文件，已解析内容仍可阅读。
              </p>
            </div>
            <Skeleton v-if="chunksLoading" class="h-16 w-full" />
            <div v-else-if="chunks.length" class="space-y-2">
              <p class="rounded-md bg-muted p-3 text-sm leading-relaxed">{{ chunks[0].content }}</p>
              <Button variant="link" size="sm" class="h-auto p-0" @click="view = 'chunks'; loadChunks()">
                查看全部 {{ chunks.length }} 个切片 <ArrowRight class="size-3" />
              </Button>
            </div>
            <div v-else class="rounded-md border border-dashed border-border p-6 text-center">
              <p class="text-sm font-medium">没有可展示的解析内容</p>
              <p class="mt-1 text-sm text-muted-foreground">
                该文件可能仍在解析，或解析结果不可用。
              </p>
            </div>
          </div>
          <div v-else class="rounded-md border border-dashed border-border p-6 text-center">
            <p class="text-sm font-medium">暂不支持预览此格式</p>
            <p class="mt-1 text-sm text-muted-foreground">当前类型：{{ previewType || "未知" }}</p>
          </div>

          <div v-if="traceOpen" class="space-y-2 rounded-md border border-border p-3">
            <p class="text-xs font-medium text-muted-foreground">处理详情</p>
            <Skeleton v-if="traceLoading" class="h-4 w-1/2" />
            <div v-for="(span, index) in trace" :key="index" class="flex items-center justify-between text-sm">
              <span>{{ String(span.name ?? span.stage ?? "阶段") }}</span>
              <span class="text-muted-foreground">{{ String(span.status ?? "") }}</span>
            </div>
            <p v-if="!traceLoading && !trace.length" class="text-sm text-muted-foreground">
              没有可展示的处理过程。
            </p>
          </div>

          <div class="mt-auto flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
            <Button
              v-if="auth.isAdmin"
              variant="link"
              size="sm"
              class="h-auto p-0"
              @click="view = 'chunks'; loadChunks()"
            >
              {{ chunks.length ? `${chunks.length} 个切片` : "查看切片" }} <ArrowRight class="size-3" />
            </Button>
            <span v-else>{{ chunks.length ? `${chunks.length} 个切片` : "" }}</span>
            <span>{{ document.parse_status || document.status || "" }}</span>
          </div>
        </template>

        <!-- 切片视图 -->
        <template v-else>
          <div v-if="chunksError" class="text-sm text-destructive">{{ chunksError }}</div>
          <Skeleton v-if="chunksLoading" class="h-6 w-2/3" />
          <template v-else>
            <div class="space-y-2">
              <button
                v-for="item in chunks"
                :key="chunkId(item)"
                class="w-full rounded-md border p-3 text-left transition-colors"
                :class="
                  selectedChunkId === chunkId(item)
                    ? 'border-ring ring-1 ring-ring'
                    : 'border-border hover:bg-muted/50'
                "
                @click="selectChunk(item)"
              >
                <span class="font-mono text-xs text-muted-foreground">{{ chunkId(item).slice(0, 12) }}</span>
                <p class="mt-1 line-clamp-3 text-sm">{{ item.content || "空切片" }}</p>
                <span
                  v-if="item.parent_chunk_id"
                  class="mt-1 block font-mono text-xs text-muted-foreground"
                  title="父切片"
                >parent {{ item.parent_chunk_id.slice(0, 8) }}</span>
              </button>
              <div v-if="!chunks.length" class="rounded-md border border-dashed border-border p-6 text-center">
                <p class="text-sm font-medium">未返回可编辑切片</p>
                <p class="mt-1 text-sm text-muted-foreground">上游没有提供切片列表。</p>
              </div>
            </div>

            <div v-if="selectedChunk" class="space-y-4 border-t border-border pt-4">
              <Label>修正切片</Label>
              <Textarea v-model="editingContent" :rows="7" />
              <label class="flex items-center gap-2 text-sm">
                <Checkbox v-model="editingEnabled" />
                启用此切片
              </label>
              <div class="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" :disabled="saving" @click="saveChunk(false)">
                  {{ saving ? "保存中" : "保存" }}
                </Button>
                <Button size="sm" :disabled="saving" @click="saveChunk(true)">
                  保存并重新验证
                </Button>
                <Button variant="outline" size="sm" :disabled="questionBusy" @click="openRevisions">
                  {{ revisionsOpen ? "收起版本" : "版本历史" }}
                </Button>
              </div>

              <div v-if="revisionsOpen" class="space-y-3 rounded-md bg-muted/50 p-3">
                <p class="text-xs font-medium text-muted-foreground">版本历史</p>
                <Skeleton v-if="revisionsLoading" class="h-4 w-2/3" />
                <div
                  v-for="revision in revisions"
                  :key="revision.content_revision"
                  class="space-y-1 rounded-md border border-border bg-background p-3"
                >
                  <div class="flex items-center justify-between gap-2">
                    <strong class="text-sm">revision {{ revision.content_revision }}</strong>
                    <Button variant="ghost" size="sm" @click="revertTo(revision)">
                      回滚到此版本
                    </Button>
                  </div>
                  <span class="text-xs text-muted-foreground">
                    {{ revision.created_at ? new Date(revision.created_at).toLocaleString() : "" }}
                  </span>
                  <p class="text-sm">{{ revision.content || "空切片" }}</p>
                </div>
                <p v-if="!revisionsLoading && !revisions.length" class="text-sm text-muted-foreground">
                  没有版本记录。
                </p>
              </div>

              <template v-if="(selectedChunk.generated_questions?.length || 0) > 0">
                <Label>已生成问题</Label>
                <ul class="ml-4 list-disc space-y-1 text-sm">
                  <li
                    v-for="(item, index) in selectedChunk.generated_questions"
                    :key="index"
                  >
                    {{ item.question }}
                  </li>
                </ul>
              </template>

              <div class="flex gap-2">
                <Input
                  v-model="newQuestion"
                  placeholder="添加生成问题…"
                  @keyup.enter="addQuestion"
                />
                <Button variant="outline" :disabled="questionBusy || !newQuestion.trim()" @click="addQuestion">
                  添加
                </Button>
                <Button variant="outline" :disabled="questionBusy" @click="regenerateQuestions">
                  重新生成
                </Button>
              </div>
            </div>
          </template>
        </template>
      </div>
    </SheetContent>
  </Sheet>
</template>

<style scoped>
/* renderMiniMarkdown 输出原生标签（v-html 不带 scoped 属性），需语义化排版 */
.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4) {
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--foreground);
  margin: 1.25em 0 0.5em;
}
.md-body :deep(h1) { font-size: 1.25rem; }
.md-body :deep(h2) { font-size: 1.125rem; }
.md-body :deep(h3),
.md-body :deep(h4) { font-size: 1rem; }
.md-body :deep(p) {
  margin: 0.5em 0;
  line-height: 1.7;
  color: var(--foreground);
}
.md-body :deep(ul) {
  margin: 0.5em 0;
  padding-left: 1.25em;
  list-style: disc;
  color: var(--foreground);
}
.md-body :deep(li) { margin: 0.25em 0; line-height: 1.6; }
.md-body :deep(a) {
  color: var(--foreground);
  text-decoration: underline;
  text-underline-offset: 4px;
}
.md-body :deep(code) {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.875em;
  background: var(--muted);
  border-radius: 4px;
  padding: 0.1em 0.3em;
}
.md-body :deep(pre) {
  background: var(--muted);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.75em 1em;
  overflow-x: auto;
  margin: 0.75em 0;
}
.md-body :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: 0.8125rem;
  line-height: 1.6;
}
.md-body :deep(hr) {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 1.25em 0;
}
</style>
