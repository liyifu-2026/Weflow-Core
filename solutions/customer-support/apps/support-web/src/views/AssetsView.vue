<script setup lang="ts">
/**
 * 素材空间管理页（平台级 /api/v1/assets 的业务前端视图）。
 *
 * 独立导航入口（非会话内弹窗）：全量网格浏览、分类切换、搜索、
 * 上传入空间、改名/删除整理、分页加载。轻量：keyset 分页按需取数。
 */
import { computed, onMounted, ref } from "vue";
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
import WfIcon from "../components/WfIcon.vue";

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

function switchCategory(next: AssetCategory | "all") {
  category.value = next;
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

onMounted(load);
</script>

<template>
  <div class="wf-asset-page">
    <header class="wf-asset-page-head">
      <div>
        <h1 class="wf-asset-page-title">素材空间</h1>
        <p class="wf-asset-page-sub">
          会话中可复用的图片与文件，选择器与这里共用同一空间。
        </p>
      </div>
      <button class="wf-button primary" :disabled="uploading" @click="triggerUpload">
        <WfIcon name="upload" :size="15" />
        {{ uploading ? "上传中…" : "上传素材" }}
      </button>
      <input
        ref="hiddenInput"
        type="file"
        :accept="accept"
        style="display: none"
        @change="onFileChosen"
      />
    </header>

    <div class="wf-asset-toolbar">
      <div class="wf-asset-tabs" role="tablist">
        <button
          v-for="c in [
            { key: 'all', label: '全部' },
            { key: 'image', label: '图片空间' },
            { key: 'file', label: '文件空间' },
          ]"
          :key="c.key"
          type="button"
          class="wf-asset-tab"
          :class="{ active: category === c.key }"
          @click="switchCategory(c.key as AssetCategory | 'all')"
        >
          {{ c.label }}
        </button>
      </div>
      <div class="wf-asset-search">
        <WfIcon name="search" :size="14" />
        <input
          v-model="searchInput"
          placeholder="搜索素材名称…"
          @keydown.enter="applySearch"
        />
        <button
          v-if="searchApplied"
          type="button"
          class="wf-link"
          @click="applySearch"
        >
          重搜
        </button>
      </div>
    </div>

    <p v-if="notice" class="wf-asset-notice">{{ notice }}</p>

    <div v-if="loading" class="wf-asset-page-empty">加载中…</div>
    <div v-else-if="!filtered.length" class="wf-asset-page-empty">
      {{ searchApplied ? "没有匹配的素材" : "空间还是空的，点右上角「上传素材」" }}
    </div>
    <template v-else>
      <div class="wf-asset-page-grid">
        <div v-for="asset in filtered" :key="asset.assetId" class="wf-asset-card">
          <button
            type="button"
            class="wf-asset-thumb"
            :title="asset.name"
            @click="openContent(asset)"
          >
            <AssetImage
              v-if="asset.category === 'image'"
              :asset-id="asset.assetId"
              :name="asset.name"
            />
            <span v-else class="wf-asset-thumb-fallback">📄</span>
          </button>
          <div class="wf-asset-meta">
            <span class="wf-asset-name" :title="asset.name">{{ asset.name }}</span>
            <span class="wf-asset-size">
              {{ formatAssetSize(asset.size) }} · {{ formatDate(asset.createdAt) }}
            </span>
          </div>
          <div class="wf-asset-actions">
            <button type="button" class="wf-link" @click="startRename(asset)">
              改名
            </button>
            <button
              type="button"
              class="wf-link danger"
              :disabled="busyId === asset.assetId"
              @click="remove(asset)"
            >
              删除
            </button>
          </div>
          <div v-if="renamingId === asset.assetId" class="wf-asset-rename">
            <input
              v-model="renameValue"
              maxlength="255"
              @keydown.enter="confirmRename"
            />
            <button
              type="button"
              class="wf-link"
              :disabled="busyId === asset.assetId || !renameValue.trim()"
              @click="confirmRename"
            >
              保存
            </button>
            <button type="button" class="wf-link" @click="renamingId = ''">
              取消
            </button>
          </div>
        </div>
      </div>
      <div v-if="nextCursor" class="wf-asset-page-more">
        <button
          class="wf-button ghost"
          :disabled="loadingMore"
          @click="loadMore"
        >
          {{ loadingMore ? "加载中…" : "加载更多" }}
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.wf-asset-page {
  padding: 24px 28px 48px;
  max-width: 1080px;
  margin: 0 auto;
}
.wf-asset-page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}
.wf-asset-page-title {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
  color: var(--wf-text, #17181a);
}
.wf-asset-page-sub {
  margin: 4px 0 0;
  color: var(--wf-text-muted, #8a93a6);
  font-size: 13px;
}
.wf-asset-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.wf-asset-tabs {
  display: flex;
  gap: 4px;
}
.wf-asset-tab {
  border: 1px solid transparent;
  background: transparent;
  padding: 6px 14px;
  border-radius: 999px;
  cursor: pointer;
  color: var(--wf-text-muted, #5b6472);
  font-size: 13px;
}
.wf-asset-tab.active {
  background: var(--wf-primary-soft, #eef3ff);
  color: var(--wf-primary, #2f5cff);
  border-color: var(--wf-primary-border, #c9d7ff);
}
.wf-asset-search {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--wf-border, #e3e6ee);
  border-radius: 8px;
  padding: 6px 10px;
  min-width: 240px;
}
.wf-asset-search input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13px;
}
.wf-asset-page-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 14px;
}
.wf-asset-card {
  border: 1px solid var(--wf-border, #e3e6ee);
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--wf-surface, #fff);
}
.wf-asset-thumb {
  height: 110px;
  width: 100%;
  padding: 0;
  border: none;
  background: var(--wf-surface-muted, #f5f6fa);
  cursor: pointer;
  display: block;
}
.wf-asset-thumb-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 26px;
  color: var(--wf-text-muted, #8a93a6);
}
.wf-asset-meta {
  padding: 8px 10px 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.wf-asset-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--wf-text, #17181a);
}
.wf-asset-size {
  font-size: 11px;
  color: var(--wf-text-muted, #8a93a6);
}
.wf-asset-actions {
  display: flex;
  gap: 10px;
  padding: 4px 10px 10px;
}
.wf-asset-rename {
  display: flex;
  gap: 6px;
  padding: 0 10px 10px;
}
.wf-asset-rename input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--wf-border, #e3e6ee);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
}
.wf-asset-page-more {
  display: flex;
  justify-content: center;
  padding-top: 20px;
}
.wf-asset-page-empty {
  text-align: center;
  color: var(--wf-text-muted, #8a93a6);
  padding: 72px 0;
  font-size: 13px;
}
.wf-asset-notice {
  color: #b42318;
  font-size: 12px;
  margin: 0 0 12px;
}
.wf-link.danger {
  color: #b42318;
}
</style>
