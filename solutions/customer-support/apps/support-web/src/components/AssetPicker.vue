<script setup lang="ts">
/**
 * 素材选择器弹窗（三来源：本机文件 / 图片空间 / 文件空间）。
 * 选择结果（上传的 File 或已有素材）由父组件决定发送方式；
 * 空间 Tab 支持分页加载 + 名称搜索 + 重命名/删除整理（管理员可见）。
 * 轻量体验：keyset 分页按需加载，不一次拉全量。
 */
import { computed, ref, watch } from "vue";
import { FileText, Loader2, Search, Upload, X } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  deleteAsset,
  formatAssetSize,
  listAssets,
  renameAsset,
  uploadAsset,
  type AssetCategory,
  type AssetItem,
} from "@/assets/api";
import AssetImage from "@/components/AssetImage.vue";

export type AssetPickResult =
  | { type: "file"; file: File; category: AssetCategory }
  | { type: "asset"; asset: AssetItem };

const props = defineProps<{ canManage?: boolean }>();
const emit = defineEmits<{ close: []; pick: [result: AssetPickResult] }>();

const tab = ref<"upload" | "image" | "file">("upload");
const items = ref<AssetItem[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const loadingMore = ref(false);
const searchInput = ref("");
const searchApplied = ref("");
const notice = ref("");
const busyId = ref("");
const renamingId = ref("");
const renameValue = ref("");
const hiddenInput = ref<HTMLInputElement | null>(null);
const accept = computed(() => (tab.value === "image" ? "image/*" : "*/*"));

const currentCategory = computed<AssetCategory | undefined>(() =>
  tab.value === "image" ? "image" : tab.value === "file" ? "file" : undefined,
);

watch(tab, () => {
  searchInput.value = "";
  searchApplied.value = "";
  renamingId.value = "";
  void reload();
});

async function reload() {
  loading.value = true;
  notice.value = "";
  try {
    const page = await listAssets({
      ...(currentCategory.value ? { category: currentCategory.value } : {}),
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
      ...(currentCategory.value ? { category: currentCategory.value } : {}),
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
  void reload();
}

function pickLocalFile() {
  hiddenInput.value?.click();
}

async function onLocalFileChosen(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  notice.value = "";
  try {
    // 本机文件也可直接入空间（持久复用），随后作为选中结果返回
    const asset = await uploadAsset(file);
    emit("pick", { type: "asset", asset });
  } catch (reason) {
    // 入空间失败（如权限受限）时降级为一次性发送，不阻塞用户
    const category: AssetCategory = file.type.startsWith("image/") ? "image" : "file";
    emit("pick", { type: "file", file, category });
    if (reason instanceof Error) notice.value = reason.message;
  }
}

function pickExisting(asset: AssetItem) {
  emit("pick", { type: "asset", asset });
}

async function startRename(asset: AssetItem) {
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

const TABS = [
  { key: "upload" as const, label: "本机文件" },
  { key: "image" as const, label: "图片空间" },
  { key: "file" as const, label: "文件空间" },
];
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-94" aria-hidden="true" @click="emit('close')"></div>
    <div
      class="fixed inset-0 z-95 mx-auto flex h-fit max-h-[80vh] w-[min(560px,calc(100vw-32px))] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg"
      role="dialog"
      aria-modal="true"
      aria-label="选择素材"
    >
      <header class="flex items-center justify-between border-b border-border px-4 py-3">
        <span class="text-sm font-semibold">选择素材</span>
        <Button variant="ghost" size="icon" aria-label="关闭" @click="emit('close')">
          <X :size="16" />
        </Button>
      </header>
      <nav class="flex gap-1 px-4 pt-3" role="tablist">
        <button
          v-for="t in TABS"
          :key="t.key"
          type="button"
          class="rounded-full px-3.5 py-1.5 text-[13px] transition-colors"
          :class="
            tab === t.key
              ? 'bg-secondary text-secondary-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          "
          role="tab"
          :aria-selected="tab === t.key"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
      </nav>

      <!-- 本机文件：选择即入空间 -->
      <div v-if="tab === 'upload'" class="flex flex-1 px-6 py-7">
        <input
          ref="hiddenInput"
          type="file"
          :accept="accept"
          class="hidden"
          @change="onLocalFileChosen"
        />
        <button
          type="button"
          class="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border-[1.5px] border-dashed border-border p-7 transition-colors hover:bg-accent"
          @click="pickLocalFile"
        >
          <Upload :size="22" class="text-muted-foreground" />
          <span class="font-semibold">选择本机文件</span>
          <span class="text-xs text-muted-foreground">上传后自动存入素材空间，方便下次复用</span>
        </button>
      </div>

      <!-- 空间浏览 -->
      <template v-else>
        <div class="flex px-4 py-2.5">
          <div class="flex flex-1 items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
            <Search :size="14" class="shrink-0 text-muted-foreground" />
            <input
              v-model="searchInput"
              placeholder="搜索名称…"
              class="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              @keydown.enter="applySearch"
            />
            <Button
              v-if="searchApplied"
              variant="link"
              class="h-auto p-0 text-xs"
              @click="applySearch"
            >
              重搜
            </Button>
          </div>
        </div>
        <div class="flex-1 overflow-y-auto px-4 pt-1 pb-4">
          <div
            v-if="loading"
            class="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
          >
            <Loader2 :size="16" class="animate-spin" /> 加载中…
          </div>
          <div v-else-if="!items.length" class="py-10 text-center text-sm text-muted-foreground">
            {{ searchApplied ? "没有匹配的素材" : "空间还是空的" }}
          </div>
          <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(108px,1fr))] gap-2.5">
            <div
              v-for="asset in items"
              :key="asset.assetId"
              class="flex flex-col overflow-hidden rounded-md border border-border bg-background"
            >
              <button
                type="button"
                class="block h-20 w-full bg-muted transition-colors hover:bg-accent"
                :title="asset.name"
                @click="pickExisting(asset)"
              >
                <AssetImage
                  v-if="asset.category === 'image'"
                  :asset-id="asset.assetId"
                  :name="asset.name"
                />
                <span v-else class="flex h-full w-full items-center justify-center text-muted-foreground">
                  <FileText :size="24" />
                </span>
              </button>
              <div class="flex flex-col gap-0.5 px-2 py-1.5">
                <span class="truncate text-xs" :title="asset.name">{{ asset.name }}</span>
                <span class="text-[11px] text-muted-foreground">{{ formatAssetSize(asset.size) }}</span>
              </div>
              <div v-if="props.canManage" class="flex gap-2 px-2 pb-1.5">
                <button
                  v-if="renamingId !== asset.assetId"
                  type="button"
                  class="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  @click="startRename(asset)"
                >
                  改名
                </button>
                <button
                  type="button"
                  class="text-xs text-destructive underline-offset-4 hover:underline"
                  :disabled="busyId === asset.assetId"
                  @click="remove(asset)"
                >
                  删除
                </button>
              </div>
              <div v-if="renamingId === asset.assetId" class="flex gap-1 px-2 pb-2">
                <Input
                  v-model="renameValue"
                  class="h-6 flex-1 min-w-0 text-xs"
                  maxlength="255"
                  @keydown.enter="confirmRename"
                />
                <Button
                  variant="link"
                  class="h-auto p-0 text-xs"
                  :disabled="busyId === asset.assetId || !renameValue.trim()"
                  @click="confirmRename"
                >
                  保存
                </Button>
                <Button variant="link" class="h-auto p-0 text-xs" @click="renamingId = ''">
                  取消
                </Button>
              </div>
            </div>
          </div>
          <div v-if="nextCursor" class="flex justify-center pt-3">
            <Button variant="outline" size="sm" :disabled="loadingMore" @click="loadMore">
              <Loader2 v-if="loadingMore" :size="14" class="animate-spin" />
              {{ loadingMore ? "加载中…" : "加载更多" }}
            </Button>
          </div>
        </div>
        <p v-if="notice" class="px-4 pb-3 text-xs text-destructive">{{ notice }}</p>
      </template>
    </div>
  </Teleport>
</template>
