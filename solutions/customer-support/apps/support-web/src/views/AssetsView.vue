<script setup lang="ts">
/**
 * 素材空间管理页（平台级 /api/v1/assets 的业务前端视图）。
 *
 * 独立导航入口（非会话内弹窗）：全量网格浏览、分类切换、搜索、
 * 上传入空间、改名/删除整理、分页加载。轻量：keyset 分页按需取数。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  CircleAlert,
  FileText,
  FolderOpen,
  Pencil,
  Search,
  Trash2,
  Upload,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  assetContentUrl,
  deleteAsset,
  formatAssetSize,
  listAssets,
  renameAsset,
  uploadAsset,
  type AssetCategory,
  type AssetItem,
} from "../assets/api";
import AssetImage from "../components/AssetImage.vue";

const items = ref<AssetItem[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const uploading = ref(false);
const busyId = ref("");
const category = ref<AssetCategory | "all">("all");
const searchInput = ref("");
const searchApplied = ref("");
const notice = ref("");
const renamingId = ref("");
const renameValue = ref("");
const hiddenInput = ref<HTMLInputElement | null>(null);

const accept = computed(() => (category.value === "image" ? "image/*" : "*/*"));
const filtered = computed(() => items.value);

const CATEGORIES = [
  { key: "all", label: "全部" },
  { key: "image", label: "图片空间" },
  { key: "file", label: "文件空间" },
] as const;

async function load() {
  loading.value = true;
  notice.value = "";
  try {
    const page = await listAssets({
      ...(category.value !== "all" ? { category: category.value } : {}),
      ...(searchApplied.value ? { search: searchApplied.value } : {}),
      limit: 30,
    });
    items.value = page.items;
    nextCursor.value = page.nextCursor;
  } catch (reason) {
    notice.value = reason instanceof Error ? reason.message : "加载失败";
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const page = await listAssets({
      ...(category.value !== "all" ? { category: category.value } : {}),
      ...(searchApplied.value ? { search: searchApplied.value } : {}),
      limit: 30,
      cursor: nextCursor.value,
    });
    items.value = [...items.value, ...page.items];
    nextCursor.value = page.nextCursor;
  } catch (reason) {
    notice.value = reason instanceof Error ? reason.message : "加载失败";
  } finally {
    loadingMore.value = false;
  }
}

function applySearch() {
  searchApplied.value = searchInput.value.trim();
  void load();
}

function switchCategory(next: string | number) {
  category.value = next as AssetCategory | "all";
  void load();
}

function triggerUpload() {
  hiddenInput.value?.click();
}

async function onFileChosen(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  uploading.value = true;
  notice.value = "";
  try {
    await uploadAsset(file);
    await load();
  } catch (reason) {
    notice.value = reason instanceof Error ? reason.message : "上传失败";
  } finally {
    uploading.value = false;
  }
}

function startRename(asset: AssetItem) {
  renamingId.value = asset.assetId;
  renameValue.value = asset.name;
}

async function confirmRename() {
  const assetId = renamingId.value;
  const name = renameValue.value.trim();
  if (!assetId || !name) return;
  busyId.value = assetId;
  try {
    const updated = await renameAsset(assetId, name);
    items.value = items.value.map((item) =>
      item.assetId === assetId ? updated : item,
    );
    renamingId.value = "";
  } catch (reason) {
    notice.value = reason instanceof Error ? reason.message : "重命名失败";
  } finally {
    busyId.value = "";
  }
}

async function remove(asset: AssetItem) {
  if (!window.confirm(`删除「${asset.name}」？已发送的消息不受影响。`)) return;
  busyId.value = asset.assetId;
  try {
    await deleteAsset(asset.assetId);
    items.value = items.value.filter((item) => item.assetId !== asset.assetId);
  } catch (reason) {
    notice.value = reason instanceof Error ? reason.message : "删除失败";
  } finally {
    busyId.value = "";
  }
}

function openContent(asset: AssetItem) {
  window.open(assetContentUrl(asset.assetId), "_blank", "noopener");
}

/** 日期投影（列表展示用） */
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

// 无限滚动：哨兵进入视口即续页（哨兵随 nextCursor 条件渲染，需动态观察）
const sentinel = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;

function observeSentinel() {
  if (sentinel.value) observer?.observe(sentinel.value);
}
onMounted(() => {
  void load();
  observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && nextCursor.value && !loadingMore.value) {
      void loadMore();
    }
  });
});
onUnmounted(() => observer?.disconnect());
watch(sentinel, (el) => {
  if (el) observeSentinel();
});
</script>

<template>
  <div class="mx-auto w-full max-w-5xl p-6">
    <header class="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">素材空间</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          会话中可复用的图片与文件，选择器与这里共用同一空间。
        </p>
      </div>
      <Button :disabled="uploading" @click="triggerUpload">
        <Upload class="size-4" />
        {{ uploading ? "上传中…" : "上传素材" }}
      </Button>
      <input
        ref="hiddenInput"
        type="file"
        :accept="accept"
        class="hidden"
        @change="onFileChosen"
      />
    </header>

    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <Tabs
        :model-value="category"
        @update:model-value="switchCategory"
      >
        <TabsList>
          <TabsTrigger
            v-for="c in CATEGORIES"
            :key="c.key"
            :value="c.key"
          >
            {{ c.label }}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <form class="relative w-full sm:w-64" @submit.prevent="applySearch">
        <Search
          class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          v-model="searchInput"
          placeholder="搜索素材名称…"
          class="pl-8"
        />
      </form>
    </div>

    <p
      v-if="notice"
      class="mb-4 flex items-center gap-2 text-sm text-destructive"
    >
      <CircleAlert class="size-4" />
      {{ notice }}
    </p>

    <!-- loading -->
    <div
      v-if="loading"
      class="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4"
    >
      <div v-for="n in 8" :key="n" class="space-y-2">
        <Skeleton class="h-[110px] w-full" />
        <Skeleton class="h-4 w-3/4" />
      </div>
    </div>

    <!-- empty -->
    <div
      v-else-if="!filtered.length"
      class="flex flex-col items-center gap-2 py-24 text-center"
    >
      <FolderOpen class="size-8 text-muted-foreground/60" />
      <p class="text-sm font-medium">
        {{ searchApplied ? "没有匹配的素材" : "空间还是空的" }}
      </p>
      <p class="text-sm text-muted-foreground">
        {{ searchApplied ? "换个关键词试试" : "点右上角「上传素材」添加第一份文件" }}
      </p>
    </div>

    <!-- grid -->
    <template v-else>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
        <div
          v-for="asset in filtered"
          :key="asset.assetId"
          class="group flex flex-col overflow-hidden rounded-lg border bg-card transition-colors hover:border-foreground/20"
        >
          <button
            type="button"
            class="flex h-[110px] w-full items-center justify-center bg-muted/50"
            :title="asset.name"
            @click="openContent(asset)"
          >
            <AssetImage
              v-if="asset.category === 'image'"
              :asset-id="asset.assetId"
              :name="asset.name"
              class="h-full w-full object-cover"
            />
            <FileText v-else class="size-8 text-muted-foreground/60" />
          </button>
          <div class="flex min-w-0 flex-col gap-0.5 p-2 pb-1">
            <span class="truncate text-sm" :title="asset.name">{{ asset.name }}</span>
            <span class="text-xs text-muted-foreground">
              {{ formatAssetSize(asset.size) }} · {{ formatDate(asset.createdAt) }}
            </span>
          </div>
          <div class="flex items-center gap-1 p-1.5 pt-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            <Button
              variant="ghost"
              size="sm"
              class="h-7 px-2 text-xs text-muted-foreground"
              :disabled="busyId === asset.assetId"
              @click="startRename(asset)"
            >
              <Pencil class="size-3.5" />
              改名
            </Button>
            <span class="grow" />
            <Button
              variant="ghost"
              size="icon"
              class="size-7 text-destructive hover:text-destructive"
              title="删除"
              :disabled="busyId === asset.assetId"
              @click="remove(asset)"
            >
              <Trash2 class="size-3.5" />
            </Button>
          </div>
          <div v-if="renamingId === asset.assetId" class="flex gap-1.5 p-2 pt-0">
            <Input
              v-model="renameValue"
              maxlength="255"
              class="h-8 text-xs"
              @keydown.enter="confirmRename"
            />
            <Button
              variant="outline"
              size="sm"
              class="h-8 shrink-0 px-2 text-xs"
              :disabled="busyId === asset.assetId || !renameValue.trim()"
              @click="confirmRename"
            >
              保存
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="h-8 shrink-0 px-2 text-xs text-muted-foreground"
              title="取消"
              @click="renamingId = ''"
            >
              取消
            </Button>
          </div>
        </div>
      </div>
      <!-- 无限滚动哨兵：进入视口即续页 -->
      <div
        v-if="nextCursor"
        ref="sentinel"
        class="flex justify-center pt-6 text-xs text-muted-foreground"
      >
        {{ loadingMore ? "正在加载…" : "" }}
      </div>
    </template>
  </div>
</template>
