<script setup lang="ts">
import { confirmDialog } from "../components/confirm-dialog";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  ArrowRight,
  Ellipsis,
  MoreVertical,
  Search,
  Upload,
} from "lucide-vue-next";
import { useWeflowAuthStore } from "../auth-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
// 「全部」用 "all" 占位（shadcn Select 不允许空串选项），请求时还原为 undefined。
const fileType = ref("all");
const parseStatus = ref("all");
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
      // Select 的「全部」用 "all" 占位（shadcn 不允许空串选项），请求时还原为 undefined。
      file_type: fileType.value && fileType.value !== "all" ? fileType.value : undefined,
      parse_status: parseStatus.value && parseStatus.value !== "all" ? parseStatus.value : undefined,
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

function stateBadgeVariant(state: string): "secondary" | "outline" | "destructive" {
  if (state === "failed") return "destructive";
  if (["pending", "processing", "finalizing"].includes(state)) return "outline";
  return "secondary";
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
    path: "/knowledge",
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
    path: "/knowledge",
    query: {
      mode: "platform",
      kb: selectedBase.value.id,
      ...originQuery(props.origin),
    },
  });
}

function duplicateSelectedBase() {
  if (!selectedBase.value) return;
  duplicateKnowledgeBase(selectedBase.value.id)
    .then(loadBases)
    .catch((reason) => (error.value = reason instanceof Error ? reason.message : String(reason)));
}

onMounted(loadBases);
onUnmounted(() => {
  stopParsePolling();
  if (keywordDebounce) clearTimeout(keywordDebounce);
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <KnowledgeStats />

    <!-- 工具栏：知识库选择 + 搜索 + 筛选 + 主操作 -->
    <div class="flex flex-wrap items-center gap-2">
      <Select
        :model-value="selectedBaseId"
        :disabled="loading"
        @update:model-value="(value) => selectBase(String(value))"
      >
        <SelectTrigger class="w-56">
          <SelectValue placeholder="选择知识库" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="item in bases" :key="item.id" :value="item.id">
            {{ item.name }}
          </SelectItem>
        </SelectContent>
      </Select>

      <Button
        v-if="selectedBase"
        variant="ghost"
        size="sm"
        title="在外部知识库完整界面中管理此知识库"
        @click="openPlatformManage"
      >
        完整管理 <ArrowRight class="size-3.5" />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon" title="知识库操作">
            <Ellipsis class="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem @click="editingBase = selectedBase">编辑设置</DropdownMenuItem>
          <DropdownMenuItem @click="createOpen = true">新建知识库</DropdownMenuItem>
          <DropdownMenuItem :disabled="!selectedBase" @click="duplicateSelectedBase">
            复制知识库
          </DropdownMenuItem>
          <DropdownMenuItem @click="togglePin">置顶知识库</DropdownMenuItem>
          <DropdownMenuItem @click="openTags">标签管理</DropdownMenuItem>
          <DropdownMenuItem @click="openActivity">活动记录</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div class="flex min-w-48 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 focus-within:ring-1 focus-within:ring-ring">
        <Search class="size-3.5 shrink-0 text-muted-foreground" />
        <input
          v-model="keyword"
          class="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder="搜索内容…"
          @keyup.enter="loadDocuments()"
        />
      </div>

      <Select v-model="fileType">
        <SelectTrigger class="w-28">
          <SelectValue placeholder="类型" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部类型</SelectItem>
          <SelectItem value="pdf">PDF</SelectItem>
          <SelectItem value="docx">Word</SelectItem>
          <SelectItem value="pptx">PPT</SelectItem>
          <SelectItem value="xlsx">Excel</SelectItem>
          <SelectItem value="md">Markdown</SelectItem>
          <SelectItem value="txt">文本</SelectItem>
          <SelectItem value="web">网页</SelectItem>
          <SelectItem value="manual">在线文本</SelectItem>
          <SelectItem value="url">URL</SelectItem>
        </SelectContent>
      </Select>

      <Select v-model="parseStatus">
        <SelectTrigger class="w-28">
          <SelectValue :placeholder="parseStatus !== 'all' ? `状态 · ${parseStatus}` : '状态'" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部状态</SelectItem>
          <SelectItem value="completed">已解析</SelectItem>
          <SelectItem value="pending">等待解析</SelectItem>
          <SelectItem value="processing">解析中</SelectItem>
          <SelectItem value="failed">解析失败</SelectItem>
          <SelectItem value="cancelled">已停止</SelectItem>
        </SelectContent>
      </Select>

      <div class="flex-1"></div>

      <Button v-if="auth.isAdmin" :disabled="!selectedBaseId" @click="uploadOpen = true">
        <Upload class="size-4" />添加知识
      </Button>
    </div>

    <p v-if="uploadNotice" class="text-sm text-muted-foreground">{{ uploadNotice }}</p>

    <Alert v-if="error" variant="destructive" class="items-center">
      <AlertDescription class="flex items-center justify-between gap-3">
        <span>{{ error }}</span>
        <Button variant="outline" size="sm" @click="loadDocuments()">重试</Button>
      </AlertDescription>
    </Alert>

    <!-- 内容类型页签：文档 / FAQ / Wiki -->
    <div
      v-if="contentTabs.length > 1"
      class="inline-flex w-fit rounded-md border border-border bg-muted p-0.5"
    >
      <button
        v-for="item in contentTabs"
        :key="item.key"
        class="rounded-[5px] px-3 py-1.5 text-sm transition-colors"
        :class="
          contentTab === item.key
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        "
        @click="contentTab = item.key"
      >
        {{ item.label }}
      </button>
    </div>

    <template v-if="contentTab === 'documents'">
      <!-- 批量操作栏 -->
      <div
        v-if="selectedIds.length"
        class="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2"
      >
        <span class="text-xs font-medium text-muted-foreground">已选 {{ selectedIds.length }} 项</span>
        <Separator orientation="vertical" class="h-4" />
        <Button variant="outline" size="sm" @click="reparseSelected">重新解析</Button>
        <Button variant="outline" size="sm" class="text-destructive hover:text-destructive" @click="removeSelected">
          删除选中
        </Button>
        <Button variant="ghost" size="sm" @click="selectedIds = []">取消</Button>
      </div>

      <!-- 文档列表 -->
      <section class="flex flex-col" aria-label="文档列表">
        <template v-if="loadingDocs">
          <div v-for="i in 5" :key="i" class="flex items-center gap-3 px-2 py-3">
            <Skeleton class="h-4 w-64" />
            <Skeleton class="h-3 w-24" />
          </div>
        </template>
        <template v-else>
          <div
            v-for="item in documents"
            :key="docId(item)"
            class="group flex cursor-pointer items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-muted/50"
            @click="openPreview(item)"
          >
            <Checkbox
              v-if="auth.isAdmin"
              :model-value="selectedIds.includes(docId(item))"
              aria-label="选择文档"
              @click.stop
              @update:model-value="() => toggleSelect(docId(item))"
            />
            <span class="min-w-0 flex-1">
              <strong class="block truncate text-sm font-medium">{{ documentTitle(item) }}</strong>
              <span class="text-xs text-muted-foreground">
                {{ documentSource(item) }}
                <template v-if="typeof item.chunk_count === 'number'">
                  · {{ item.chunk_count }} 个切片
                </template>
              </span>
            </span>
            <Badge :variant="stateBadgeVariant(documentState(item))" class="shrink-0">
              {{ stateLabel(documentState(item)) }}
            </Badge>
            <span class="hidden w-24 shrink-0 text-right text-xs text-muted-foreground md:block">
              {{ item.updated_at ? new Date(item.updated_at).toLocaleDateString() : "—" }}
            </span>
            <DropdownMenu v-if="auth.isAdmin" @click.stop>
              <DropdownMenuTrigger as-child>
                <Button
                  variant="ghost"
                  size="icon"
                  class="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  title="更多操作"
                  @click.stop
                >
                  <MoreVertical class="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem @click="reparseOne(item)">重新解析</DropdownMenuItem>
                <DropdownMenuItem v-if="canCancelParse(item)" @click="cancelParseOne(item)">
                  停止解析
                </DropdownMenuItem>
                <DropdownMenuItem @click="openMove(item)">移动到…</DropdownMenuItem>
                <DropdownMenuItem
                  class="text-destructive focus:text-destructive"
                  @click="removeOne(item)"
                >
                  删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <Button
            v-if="hasMoreDocs && documents.length"
            variant="ghost"
            size="sm"
            class="mx-auto mt-2"
            :disabled="loadingMoreDocs"
            @click="loadDocuments(false)"
          >
            {{ loadingMoreDocs ? "正在加载…" : "加载更多" }}
          </Button>

          <div v-if="!documents.length" class="rounded-md border border-dashed border-border p-8 text-center">
            <p class="text-sm font-medium">当前知识库还没有内容</p>
            <p class="mt-1 text-sm text-muted-foreground">
              <template v-if="auth.isAdmin">点击「添加知识」上传文件、URL 或在线文本。</template>
              <template v-else>管理员添加内容后，Agent 才能检索到依据。</template>
            </p>
          </div>
        </template>
      </section>
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

    <!-- 标签管理 -->
    <Dialog :open="tagsOpen" @update:open="(value) => (tagsOpen = value)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>标签管理</DialogTitle>
        </DialogHeader>
        <div class="space-y-4">
          <div class="flex gap-2">
            <Input v-model="newTagName" placeholder="新标签名称…" @keyup.enter="createTag" />
            <Button :disabled="!newTagName.trim()" @click="createTag">创建</Button>
          </div>
          <div v-for="tag in tags" :key="tag.id" class="flex items-center justify-between gap-2">
            <Badge variant="secondary">{{ tag.name }}</Badge>
            <Button variant="ghost" size="sm" class="text-destructive hover:text-destructive" @click="removeTag(tag)">
              删除
            </Button>
          </div>
          <div v-if="!tags.length" class="py-4 text-center">
            <p class="text-sm font-medium">还没有标签</p>
            <p class="mt-1 text-sm text-muted-foreground">创建标签后，上传内容时可选择标签归类。</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>

    <!-- 移动到… -->
    <Dialog :open="moveOpen" @update:open="(value) => (moveOpen = value)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>移动到…</DialogTitle>
          <DialogDescription>
            {{ moveDocument ? documentTitle(moveDocument) : "" }} 将移动到：
          </DialogDescription>
        </DialogHeader>
        <Select v-model="moveTarget">
          <SelectTrigger>
            <SelectValue placeholder="选择目标知识库…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="item in moveTargets" :key="item.id" :value="item.id">
              {{ item.name }}
            </SelectItem>
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="outline" @click="moveOpen = false">取消</Button>
          <Button :disabled="!moveTarget" @click="confirmMove">确认移动</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 活动记录 -->
    <Dialog :open="activityOpen" @update:open="(value) => (activityOpen = value)">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>活动记录</DialogTitle>
        </DialogHeader>
        <div class="max-h-96 space-y-3 overflow-y-auto">
          <Skeleton v-if="activityLoading" class="h-4 w-3/4" />
          <template v-else>
            <div v-for="(event, index) in activity" :key="index" class="space-y-0.5">
              <p class="text-sm">{{ String(event.action ?? event.event_type ?? "操作") }}</p>
              <p class="text-xs text-muted-foreground">
                {{ String(event.actor_name ?? event.actor ?? "") }}
                {{
                  event.created_at
                    ? new Date(String(event.created_at)).toLocaleString()
                    : ""
                }}
              </p>
            </div>
            <Alert v-if="activityError" variant="destructive">
              <AlertDescription>{{ activityError }}</AlertDescription>
            </Alert>
            <div v-if="!activity.length && !activityError" class="py-4 text-center">
              <p class="text-sm text-muted-foreground">暂无活动记录</p>
            </div>
          </template>
        </div>
      </DialogContent>
    </Dialog>

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
  </div>
</template>
