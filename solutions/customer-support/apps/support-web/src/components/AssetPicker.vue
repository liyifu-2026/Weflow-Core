<script setup lang="ts">
/**
 * 素材选择器弹窗（三来源：本机文件 / 图片空间 / 文件空间）。
 * 选择结果（上传的 File 或已有素材）由父组件决定发送方式；
 * 空间 Tab 支持分页加载 + 名称搜索 + 重命名/删除整理（管理员可见）。
 * 轻量体验：keyset 分页按需加载，不一次拉全量。
 */
import { computed, ref, watch } from "vue";
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
import WfIcon from "@/components/WfIcon.vue";

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
</script>

<template>
  <button
    class="wf-drawer-backdrop"
    aria-label="关闭素材选择"
    @click="emit('close')"
  ></button>
  <div class="wf-asset-picker" role="dialog" aria-modal="true" aria-label="选择素材">
    <header class="wf-asset-picker-head">
      <strong>选择素材</strong>
      <button class="wf-icon-button" aria-label="关闭" @click="emit('close')">×</button>
    </header>
    <nav class="wf-asset-tabs" role="tablist">
      <button
        v-for="t in [
          { key: 'upload', label: '本机文件' },
          { key: 'image', label: '图片空间' },
          { key: 'file', label: '文件空间' },
        ]"
        :key="t.key"
        type="button"
        class="wf-asset-tab"
        :class="{ active: tab === t.key }"
        role="tab"
        :aria-selected="tab === t.key"
        @click="tab = t.key as typeof tab"
      >
        {{ t.label }}
      </button>
    </nav>

    <!-- 本机文件：选择即入空间 -->
    <div v-if="tab === 'upload'" class="wf-asset-upload-pane">
      <input
        ref="hiddenInput"
        type="file"
        :accept="accept"
        style="display: none"
        @change="onLocalFileChosen"
      />
      <button type="button" class="wf-asset-upload-drop" @click="pickLocalFile">
        <WfIcon name="upload" :size="22" />
        <strong>选择本机文件</strong>
        <span>上传后自动存入素材空间，方便下次复用</span>
      </button>
    </div>

    <!-- 空间浏览 -->
    <template v-else>
      <div class="wf-asset-toolbar">
        <div class="wf-asset-search">
          <WfIcon name="search" :size="14" />
          <input
            v-model="searchInput"
            placeholder="搜索名称…"
            @keydown.enter="applySearch"
          />
          <button v-if="searchApplied" type="button" class="wf-link" @click="applySearch">
            重搜
          </button>
        </div>
      </div>
      <div class="wf-asset-grid-wrap">
        <div v-if="loading" class="wf-asset-empty">加载中…</div>
        <div v-else-if="!items.length" class="wf-asset-empty">
          {{ searchApplied ? "没有匹配的素材" : "空间还是空的" }}
        </div>
        <div v-else class="wf-asset-grid">
          <div v-for="asset in items" :key="asset.assetId" class="wf-asset-card">
            <button
              type="button"
              class="wf-asset-thumb"
              :title="asset.name"
              @click="pickExisting(asset)"
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
              <span class="wf-asset-size">{{ formatAssetSize(asset.size) }}</span>
            </div>
            <div v-if="props.canManage" class="wf-asset-actions">
              <button
                v-if="renamingId !== asset.assetId"
                type="button"
                class="wf-link"
                @click="startRename(asset)"
              >
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
        <div v-if="nextCursor" class="wf-asset-more">
          <button
            type="button"
            class="wf-button ghost"
            :disabled="loadingMore"
            @click="loadMore"
          >
            {{ loadingMore ? "加载中…" : "加载更多" }}
          </button>
        </div>
      </div>
      <p v-if="notice" class="wf-asset-notice">{{ notice }}</p>
    </template>
  </div>
</template>

<style scoped>
.wf-asset-picker {
  position: fixed;
  inset: 0;
  max-width: 560px;
  max-height: 640px;
  margin: auto;
  background: var(--wf-surface, #fff);
  border: 1px solid var(--wf-border, #e3e6ee);
  border-radius: 12px;
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18);
  display: flex;
  flex-direction: column;
  /* 高于全局 .wf-drawer-backdrop(89)/抽屉(90)，低于全局模态层(100) */
  z-index: 95;
  overflow: hidden;
}
.wf-asset-picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--wf-border, #e3e6ee);
}
.wf-asset-tabs {
  display: flex;
  gap: 4px;
  padding: 10px 16px 0;
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
.wf-asset-upload-pane {
  padding: 28px 24px;
  display: flex;
  flex: 1;
}
.wf-asset-upload-drop {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1.5px dashed var(--wf-border-strong, #c3c9d6);
  border-radius: 12px;
  background: transparent;
  cursor: pointer;
  color: var(--wf-text, #1f2733);
  padding: 28px;
}
.wf-asset-upload-drop span {
  color: var(--wf-text-muted, #8a93a6);
  font-size: 12px;
}
.wf-asset-toolbar {
  display: flex;
  padding: 10px 16px;
}
.wf-asset-search {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--wf-border, #e3e6ee);
  border-radius: 8px;
  padding: 6px 10px;
}
.wf-asset-search input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13px;
}
.wf-asset-grid-wrap {
  flex: 1;
  overflow-y: auto;
  padding: 4px 16px 16px;
}
.wf-asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(108px, 1fr));
  gap: 10px;
}
.wf-asset-card {
  border: 1px solid var(--wf-border, #e3e6ee);
  border-radius: 10px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--wf-surface, #fff);
}
.wf-asset-thumb {
  height: 78px;
  width: 100%;
  padding: 0;
  border: none;
  background: var(--wf-surface-muted, #f5f6fa);
  cursor: pointer;
  display: block;
}
.wf-asset-meta {
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.wf-asset-name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wf-asset-size {
  font-size: 11px;
  color: var(--wf-text-muted, #8a93a6);
}
.wf-asset-actions {
  display: flex;
  gap: 8px;
  padding: 0 8px 6px;
}
.wf-asset-rename {
  display: flex;
  gap: 4px;
  padding: 0 8px 8px;
}
.wf-asset-rename input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--wf-border, #e3e6ee);
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 12px;
}
.wf-asset-more {
  display: flex;
  justify-content: center;
  padding-top: 12px;
}
.wf-asset-empty {
  text-align: center;
  color: var(--wf-text-muted, #8a93a6);
  padding: 40px 0;
  font-size: 13px;
}
.wf-asset-notice {
  padding: 0 16px 12px;
  color: #b42318;
  font-size: 12px;
}
.wf-link.danger {
  color: #b42318;
}
</style>
