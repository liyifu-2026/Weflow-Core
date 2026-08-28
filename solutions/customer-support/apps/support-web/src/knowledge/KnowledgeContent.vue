<script setup lang="ts">
import { confirmDialog } from "../components/confirm-dialog";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useWeflowAuthStore } from "../auth-store";
import WfIcon from "../components/WfIcon.vue";
import { sourceTypeLabel, stateLabel } from "../labels";
import { originQuery } from "../navigation-context";
import { useEscClose } from "../composables/use-esc-close";
import {
  batchDeleteKnowledge,
  batchReparseKnowledge,
  cancelKnowledgeParse,
  createKnowledgeBaseTag,
  deleteKnowledgeBaseTag,
  duplicateKnowledgeBase,
  listKnowledgeBaseActivity,
  listKnowledgeBases,
  listKnowledgeFiles,
  listKnowledgeTags,
  listMoveTargets,
  moveKnowledge,
  reparseKnowledge,
  togglePinKnowledgeBase,
  type KnowledgeBase,
  type KnowledgeDocument,
  type KnowledgeTag,
} from "./api";
import KnowledgeBaseEditorDialog from "./KnowledgeBaseEditorDialog.vue";
import KnowledgeFaq from "./KnowledgeFaq.vue";
import KnowledgePreviewDrawer from "./KnowledgePreviewDrawer.vue";
import WfInspector from "../components/WfInspector.vue";
import KnowledgeStats from "./KnowledgeStats.vue";
import KnowledgeUploadDialog from "./KnowledgeUploadDialog.vue";
import KnowledgeWiki from "./KnowledgeWiki.vue";

const props = defineProps<{ origin: import("../navigation-context").NavigationOrigin }>();

const auth = useWeflowAuthStore();
const route = useRoute();
const router = useRouter();

const bases = ref<KnowledgeBase[]>([]);
const selectedBaseId = ref("");
const documents = ref<KnowledgeDocument[]>([]);
const loading = ref(true);
const loadingDocs = ref(false);
const error = ref("");
const keyword = ref("");
const fileType = ref("");
const parseStatus = ref("");
const selectedIds = ref<string[]>([]);
const editingBase = ref<KnowledgeBase | null | undefined>(null);
const createOpen = ref(false);
const uploadOpen = ref(false);
const previewDocument = ref<KnowledgeDocument | null>(null);
const activityOpen = ref(false);
const activity = ref<Array<Record<string, unknown>>>([]);
const activityLoading = ref(false);
const moveOpen = ref(false);
const moveDocument = ref<KnowledgeDocument | null>(null);
const moveTargets = ref<KnowledgeBase[]>([]);
const moveTarget = ref("");
const contentTab = ref<"documents" | "faq" | "wiki">("documents");
const tagsOpen = ref(false);
const tags = ref<KnowledgeTag[]>([]);
const newTagName = ref("");
useEscClose(
  computed(
    () => activityOpen.value || tagsOpen.value || moveOpen.value,
  ),
  () => {
    activityOpen.value = false;
    tagsOpen.value = false;
    moveOpen.value = false;
  },
);
// Parse-state polling: 只要有文档仍在解析就继续轮询（无 3 分钟硬停，
// 避免"解析中"状态无人更新）；上限 30 分钟防异常卡死。
const PARSE_POLL_INTERVAL_MS = 3000;
const PARSE_POLL_MAX_TICKS = 600;
const uploadNotice = ref("");
let parseTimer: ReturnType<typeof setInterval> | undefined;
let parseTicks = 0;

// 文档列表分页：首页 30 条，「加载更多」追加下一页。
const PAGE_SIZE = 30;
const docsPage = ref(1);
const hasMoreDocs = ref(false);
const loadingMoreDocs = ref(false);

// 搜索防抖：停止输入 300ms 后自动检索，避免每次击键都请求。
let keywordDebounce: ReturnType<typeof setTimeout> | undefined;
watch(keyword, () => {
  if (keywordDebounce) clearTimeout(keywordDebounce);
  keywordDebounce = setTimeout(() => {
    void loadDocuments();
  }, 300);
});

const hasInFlightParses = computed(() =>
  documents.value.some((item) =>
    ["pending", "processing", "finalizing"].includes(documentState(item)),
  ),
);

function stopParsePolling() {
  if (parseTimer) {
    clearInterval(parseTimer);
    parseTimer = undefined;
  }
}

function startParsePolling() {
  stopParsePolling();
  parseTicks = 0;
  if (!hasInFlightParses.value) return;
  parseTimer = setInterval(async () => {
    parseTicks += 1;
    await loadDocuments();
    if (parseTicks >= PARSE_POLL_MAX_TICKS) {
      stopParsePolling();
      uploadNotice.value =
        "部分文档解析时间较长，仍在后台进行；刷新页面可查看最新状态。";
    } else if (!hasInFlightParses.value) {
      stopParsePolling();
    }
  }, PARSE_POLL_INTERVAL_MS);
}

const kbType = computed(() => selectedBase.value?.type ?? "document");
const kbWiki = computed(() => Boolean(selectedBase.value?.wiki));
const contentTabs = computed(() => {
  const tabs: Array<{ key: "documents" | "faq" | "wiki"; label: string }> = [
    { key: "documents", label: "文档" },
  ];
  if (kbType.value === "faq") tabs.push({ key: "faq", label: "FAQ" });
  if (kbWiki.value) tabs.push({ key: "wiki", label: "Wiki" });
  return tabs;
});

const selectedBase = computed(() =>
  bases.value.find((item) => item.id === selectedBaseId.value),
);
const docId = (item: KnowledgeDocument) =>
  String(item.id ?? item.knowledge_id ?? "");

async function loadBases() {
  loading.value = true;
  error.value = "";
  try {
    bases.value = await listKnowledgeBases();
    const routeBase =
      typeof route.query.knowledgeBaseId === "string"
        ? route.query.knowledgeBaseId
        : "";
    if (routeBase && bases.value.some((item) => item.id === routeBase)) {
      selectedBaseId.value = routeBase;
    } else if (!selectedBaseId.value && bases.value[0]) {
      selectedBaseId.value = bases.value[0].id;
    }
    if (selectedBaseId.value) await loadDocuments();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "知识库加载失败";
  } finally {
    loading.value = false;
  }
}

async function loadDocuments(reset = true) {
  if (!selectedBaseId.value) return;
  if (reset) {
    loadingDocs.value = true;
    docsPage.value = 1;
  } else {
    if (loadingMoreDocs.value || !hasMoreDocs.value) return;
    loadingMoreDocs.value = true;
    docsPage.value += 1;
  }
  error.value = "";
  try {
    const page = await listKnowledgeFiles(selectedBaseId.value, {
      keyword: keyword.value.trim() || undefined,
      file_type: fileType.value || undefined,
      parse_status: parseStatus.value || undefined,
      page: docsPage.value,
      page_size: PAGE_SIZE,
    });
    hasMoreDocs.value = page.length >= PAGE_SIZE;
    if (reset) {
      documents.value = page;
    } else {
      const seen = new Set(documents.value.map((item) => docId(item)));
      documents.value = [
        ...documents.value,
        ...page.filter((item) => !seen.has(docId(item))),
      ];
    }
    // URL object targeting: ?mode=content&documentId=... opens the preview
    // once the list has loaded (the watcher may fire before documents arrive).
    const routeDoc =
      typeof route.query.documentId === "string" ? route.query.documentId : "";
    if (routeDoc && !previewDocument.value) {
      const target = documents.value.find((item) => docId(item) === routeDoc);
      if (target) previewDocument.value = target;
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "内容加载失败";
    if (!reset) docsPage.value = Math.max(1, docsPage.value - 1);
  } finally {
    if (reset) loadingDocs.value = false;
    else loadingMoreDocs.value = false;
  }
}

function selectBase(id: string) {
  selectedBaseId.value = id;
  selectedIds.value = [];
  contentTab.value = "documents";
  void loadDocuments();
}

function toggleSelect(id: string) {
  const index = selectedIds.value.indexOf(id);
  if (index >= 0) selectedIds.value.splice(index, 1);
  else selectedIds.value.push(id);
}

function openPreview(item: KnowledgeDocument) {
  previewDocument.value = item;
}

function documentTitle(item: KnowledgeDocument) {
  return (
    item.title ||
    item.name ||
    item.file_name ||
    item.filename ||
    item.url ||
    "未命名内容"
  );
}

function documentSource(item: KnowledgeDocument) {
  return sourceTypeLabel(item.source_type || item.source || item.type);
}

function documentState(item: KnowledgeDocument) {
  return item.parse_status || item.status || item.sync_status || "ready";
}

async function removeSelected() {
  const ids = [...selectedIds.value];
  if (!ids.length) return;
  if (!await confirmDialog(`删除选中的 ${ids.length} 项内容？该操作会被审计。`)) return;
  try {
    await batchDeleteKnowledge(ids);
    selectedIds.value = [];
    await loadDocuments();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "删除失败";
  }
}

async function reparseSelected() {
  const ids = [...selectedIds.value];
  if (!ids.length || !selectedBaseId.value) return;
  if (!await confirmDialog(`重新解析选中的 ${ids.length} 项内容？`)) return;
  try {
    await batchReparseKnowledge(selectedBaseId.value, ids);
    selectedIds.value = [];
    await loadDocuments();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "重新解析失败";
  }
}

async function reparseOne(item: KnowledgeDocument) {
  if (!await confirmDialog(`重新解析「${documentTitle(item)}」？`)) return;
  try {
    await reparseKnowledge(docId(item));
    await loadDocuments();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "重新解析失败";
  }
}

async function cancelParseOne(item: KnowledgeDocument) {
  try {
    await cancelKnowledgeParse(docId(item));
    await loadDocuments();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "停止解析失败";
  }
}

async function removeOne(item: KnowledgeDocument) {
  if (!await confirmDialog(`删除「${documentTitle(item)}」？该操作会被审计。`)) return;
  try {
    await batchDeleteKnowledge([docId(item)]);
    await loadDocuments();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "删除失败";
  }
}

async function openMove(item: KnowledgeDocument) {
  moveDocument.value = item;
  moveTarget.value = "";
  moveOpen.value = true;
  try {
    moveTargets.value = await listMoveTargets(selectedBaseId.value);
  } catch {
    moveTargets.value = [];
  }
}

async function confirmMove() {
  if (!moveDocument.value || !moveTarget.value) return;
  try {
    await moveKnowledge({
      id: docId(moveDocument.value),
      target_kb_id: moveTarget.value,
    });
    moveOpen.value = false;
    moveDocument.value = null;
    await loadDocuments();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "移动失败";
  }
}

function canCancelParse(item: KnowledgeDocument) {
  return ["pending", "processing", "finalizing"].includes(
    documentState(item),
  );
}

const activityError = ref("");
async function openActivity() {
  if (!selectedBaseId.value) return;
  activityOpen.value = true;
  activityLoading.value = true;
  activity.value = [];
  activityError.value = "";
  try {
    activity.value = await listKnowledgeBaseActivity(selectedBaseId.value);
  } catch (reason) {
    // 如实展示能力不可用，而不是伪装成"没有记录"。
    activityError.value =
      reason instanceof Error ? reason.message : "活动记录当前不可用";
  } finally {
    activityLoading.value = false;
  }
}

async function togglePin() {
  if (!selectedBaseId.value) return;
  try {
    await togglePinKnowledgeBase(selectedBaseId.value);
    await loadBases();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "操作失败";
  }
}

async function openTags() {
  if (!selectedBaseId.value) return;
  tagsOpen.value = true;
  newTagName.value = "";
  try {
    tags.value = await listKnowledgeTags(selectedBaseId.value);
  } catch {
    tags.value = [];
  }
}

async function createTag() {
  if (!selectedBaseId.value || !newTagName.value.trim()) return;
  try {
    await createKnowledgeBaseTag(selectedBaseId.value, {
      name: newTagName.value.trim(),
    });
    newTagName.value = "";
    tags.value = await listKnowledgeTags(selectedBaseId.value);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "标签创建失败";
  }
}

async function removeTag(tag: KnowledgeTag) {
  if (!selectedBaseId.value) return;
  if (!await confirmDialog(`删除标签「${tag.name}」？`)) return;
  try {
    await deleteKnowledgeBaseTag(selectedBaseId.value, tag.id);
    tags.value = await listKnowledgeTags(selectedBaseId.value);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "标签删除失败";
  }
}

// URL object targeting: ?mode=content&documentId=...&chunkId=... opens the
// preview drawer and selects the chunk (evidence → chunk → edit loop).
watch(
  () => route.query.documentId,
  (value) => {
    if (typeof value === "string" && value) {
      const target = documents.value.find((item) => docId(item) === value);
      if (target) previewDocument.value = target;
    }
  },
);

function revalidateFromChunkEdit() {
  void router.push({
    path: "/support/knowledge",
    query: {
      mode: "validate",
      ...originQuery(props.origin),
    },
  });
}

/** 跳转到「平台管理」模式，在外部知识库完整界面中深链当前知识库 */
function openPlatformManage() {
  if (!selectedBase.value) return;
  void router.push({
    path: "/support/knowledge",
    query: {
      mode: "platform",
      kb: selectedBase.value.id,
      ...originQuery(props.origin),
    },
  });
}

onMounted(loadBases);
onUnmounted(() => {
  stopParsePolling();
  if (keywordDebounce) clearTimeout(keywordDebounce);
});
</script>

<template>
  <div class="wf-content-workspace">
    <KnowledgeStats />
    <div class="wf-content-toolbar">
      <select
        v-model="selectedBaseId"
        class="wf-select wf-kb-select"
        :disabled="loading"
        @change="selectBase(selectedBaseId)"
      >
        <option v-for="item in bases" :key="item.id" :value="item.id">
          {{ item.name }}
        </option>
      </select>
      <button
        v-if="selectedBase"
        class="wf-button compact"
        title="在外部知识库完整界面中管理此知识库"
        @click="openPlatformManage"
      >
        完整管理 →
      </button>
      <details class="wf-row-menu wf-kb-menu">
        <summary class="wf-icon-button" title="知识库操作">···</summary>        <div>
          <button @click="editingBase = selectedBase">编辑设置</button>
          <button @click="createOpen = true">新建知识库</button>
          <button
            v-if="selectedBase"
            @click="
              duplicateKnowledgeBase(selectedBase.id)
                .then(loadBases)
                .catch((reason) => (error = reason instanceof Error ? reason.message : String(reason)))
            "
          >
            复制知识库
          </button>
          <button @click="togglePin">置顶知识库</button>
          <button @click="openTags">标签管理</button>
          <button @click="openActivity">活动记录</button>
        </div>
      </details>
      <div class="wf-search">
        <WfIcon name="search" :size="15" />
        <input
          v-model="keyword"
          class="wf-input"
          placeholder="搜索内容…"
          @keyup.enter="loadDocuments()"
        />
      </div>
      <select v-model="fileType" class="wf-select wf-filter-select" @change="loadDocuments()">
        <option value="">类型</option>
        <option value="pdf">PDF</option>
        <option value="docx">Word</option>
        <option value="pptx">PPT</option>
        <option value="xlsx">Excel</option>
        <option value="md">Markdown</option>
        <option value="txt">文本</option>
        <option value="web">网页</option>
        <option value="manual">在线文本</option>
        <option value="url">URL</option>
      </select>
      <details class="wf-row-menu wf-filter-menu wf-filter-trigger">
        <summary class="wf-button compact">{{ parseStatus ? `状态 · ${parseStatus}` : "筛选" }}</summary>
        <div>
          <select v-model="parseStatus" class="wf-select" @change="loadDocuments()">
            <option value="">全部状态</option>
            <option value="completed">已解析</option>
            <option value="pending">等待解析</option>
            <option value="processing">解析中</option>
            <option value="failed">解析失败</option>
            <option value="cancelled">已停止</option>
          </select>
          <button class="wf-button compact" @click="parseStatus = ''; loadDocuments()">
            清除
          </button>
        </div>
      </details>
      <div class="wf-spacer"></div>
      <button
        v-if="auth.isAdmin"
        class="wf-button primary"
        @click="uploadOpen = true"
        :disabled="!selectedBaseId"
      >
        <WfIcon name="upload" :size="15" />添加知识
      </button>
    </div>

    <div v-if="error" class="wf-error">
      <span>{{ error }}</span
      ><button class="wf-button compact" @click="loadDocuments()">重试</button>
    </div>

    <div class="wf-queue-tabs wf-content-tabs" v-if="contentTabs.length > 1">
      <button
        v-for="item in contentTabs"
        :key="item.key"
        class="wf-tab"
        :class="{ active: contentTab === item.key }"
        @click="contentTab = item.key"
      >
        {{ item.label }}
      </button>
    </div>

    <template v-if="contentTab === 'documents'">
    <div v-if="selectedIds.length" class="wf-batch-bar">
      <span class="wf-section-caption">已选 {{ selectedIds.length }} 项</span>
      <button class="wf-button compact" @click="reparseSelected">
        重新解析
      </button>
      <button class="wf-button compact danger" @click="removeSelected">
        删除选中
      </button>
      <button class="wf-button compact" @click="selectedIds = []">取消</button>
    </div>

    <section class="wf-content-list">
      <template v-if="loadingDocs">
        <div v-for="i in 5" :key="i" class="wf-content-row">
          <div class="wf-skeleton wf-skeleton-title"></div>
          <div class="wf-skeleton wf-skeleton-line"></div>
        </div>
      </template>
      <template v-else>
        <div
          v-for="item in documents"
          :key="docId(item)"
          class="wf-content-row"
          @click="openPreview(item)"
        >
          <span
            v-if="auth.isAdmin"
            class="wf-check"
            :class="{ checked: selectedIds.includes(docId(item)) }"
            role="checkbox"
            :aria-checked="selectedIds.includes(docId(item))"
            @click.stop="toggleSelect(docId(item))"
            >{{ selectedIds.includes(docId(item)) ? "✓" : "" }}</span
          >
          <span class="wf-content-name">
            <strong>{{ documentTitle(item) }}</strong>
            <span class="wf-muted">
              {{ documentSource(item) }}
              <template v-if="typeof item.chunk_count === 'number'">
                · {{ item.chunk_count }} 个切片
              </template>
            </span>
          </span>
          <span class="wf-content-state" :class="documentState(item)">
            {{ stateLabel(documentState(item)) }}          </span>
          <span class="wf-content-time">{{
            item.updated_at
              ? new Date(item.updated_at).toLocaleDateString()
              : "—"
          }}</span>
          <details
            v-if="auth.isAdmin"
            class="wf-row-menu wf-content-menu"
            @click.stop
          >
            <summary class="wf-icon-button" title="更多操作">···</summary>
            <div>
              <button @click="reparseOne(item)">重新解析</button>
              <button
                v-if="canCancelParse(item)"
                @click="cancelParseOne(item)"
              >
                停止解析
              </button>
              <button @click="openMove(item)">移动到…</button>
              <button class="danger" @click="removeOne(item)">删除</button>
            </div>
          </details>
        </div>
        <button
          v-if="hasMoreDocs && documents.length"
          class="wf-load-more"
          :disabled="loadingMoreDocs"
          @click="loadDocuments(false)"
        >
          {{ loadingMoreDocs ? "正在加载…" : "加载更多" }}
        </button>
        <div v-if="!documents.length" class="wf-empty">
          <div>
            <strong>当前知识库还没有内容</strong>
            <p v-if="auth.isAdmin">点击「添加知识」上传文件、URL 或在线文本。</p>
            <p v-else>管理员添加内容后，Agent 才能检索到依据。</p>
          </div>
        </div>
      </template>
    </section>

    <KnowledgeUploadDialog
      v-if="uploadOpen"
      :kb-id="selectedBaseId"
      :faq-enabled="kbType === 'faq'"
      @close="uploadOpen = false"
      @done="
        uploadNotice = '上传成功，正在解析…';
        loadDocuments();
        startParsePolling()
      "
    />
    <KnowledgeBaseEditorDialog
      v-if="createOpen"
      @close="createOpen = false"
      @done="loadBases()"
    />
    <KnowledgeBaseEditorDialog
      v-if="editingBase"
      :base="editingBase"
      @close="editingBase = null"
      @done="loadBases()"
    />
    <KnowledgePreviewDrawer
      v-if="previewDocument"
      :document="previewDocument"
      :kb-id="selectedBaseId"
      :origin="props.origin"
      :initial-chunk-id="
        typeof route.query.chunkId === 'string' ? route.query.chunkId : undefined
      "
      @close="previewDocument = null"
      @changed="loadDocuments()"
      @revalidate="revalidateFromChunkEdit"
    />
    </template>

    <KnowledgeFaq
      v-else-if="contentTab === 'faq' && selectedBaseId"
      :kb-id="selectedBaseId"
      @error="error = $event"
    />
    <KnowledgeWiki
      v-else-if="contentTab === 'wiki' && selectedBaseId"
      :kb-id="selectedBaseId"
      @error="error = $event"
    />

    <WfInspector
      variant="overlay"
      :open="tagsOpen"
      title="标签管理"
      @close="tagsOpen = false"
    >
      <template v-if="tagsOpen">
          <div class="wf-question-form">
            <input
              v-model="newTagName"
              class="wf-input"
              placeholder="新标签名称…"
              @keyup.enter="createTag"
            />
            <button
              class="wf-button compact primary"
              :disabled="!newTagName.trim()"
              @click="createTag"
            >
              创建
            </button>
          </div>
          <div v-for="tag in tags" :key="tag.id" class="wf-tag-manage-row">
            <span class="wf-tag-chip">{{ tag.name }}</span>
            <button
              class="wf-button compact danger"
              @click="removeTag(tag)"
            >
              删除
            </button>
          </div>
          <div v-if="!tags.length" class="wf-empty wf-empty-compact">
            <div>
              <strong>还没有标签</strong>
              <p>创建标签后，上传内容时可选择标签归类。</p>
            </div>
          </div>
      </template>
    </WfInspector>

    <div
      v-if="moveOpen"
      class="wf-modal-mask"
      @click.self="moveOpen = false"
    >
      <div class="wf-modal wf-modal-narrow">
        <div class="wf-modal-head">
          <h3>移动到…</h3>
          <button class="wf-icon-button" @click="moveOpen = false">×</button>
        </div>
        <div class="wf-modal-body">
          <p class="wf-muted">
            {{ moveDocument ? documentTitle(moveDocument) : "" }} 将移动到：
          </p>
          <select v-model="moveTarget" class="wf-select">
            <option value="">选择目标知识库…</option>
            <option
              v-for="item in moveTargets"
              :key="item.id"
              :value="item.id"
            >
              {{ item.name }}
            </option>
          </select>
        </div>
        <div class="wf-modal-foot">
          <button class="wf-button" @click="moveOpen = false">取消</button>
          <button
            class="wf-button primary"
            :disabled="!moveTarget"
            @click="confirmMove"
          >
            确认移动
          </button>
        </div>
      </div>
    </div>

    <WfInspector
      variant="overlay"
      :open="activityOpen"
      title="活动记录"
      @close="activityOpen = false"
    >
      <template v-if="activityOpen">
          <div v-if="activityLoading" class="wf-skeleton wf-skeleton-title"></div>
          <div
            v-for="(event, index) in activity"
            :key="index"
            class="wf-inspector-section"
          >
            <p class="wf-brief-text">
              {{ String(event.action ?? event.event_type ?? "操作") }}
            </p>
            <p class="wf-muted">
              {{ String(event.actor_name ?? event.actor ?? "") }}
              {{
                event.created_at
                  ? new Date(String(event.created_at)).toLocaleString()
                  : ""
              }}
            </p>
          </div>
          <div v-if="!activityLoading && !activity.length" class="wf-empty">
            <div>
              <strong>暂无活动记录</strong>
            </div>
          </div>
      </template>
    </WfInspector>
  </div>
</template>

