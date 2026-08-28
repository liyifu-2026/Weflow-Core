<script setup lang="ts">
/**
 * 白名单配置页（admin only）
 *
 * - 列表来源：GET /api/v1/contacts（已支持 q + agentEnabled + 游标分页）
 * - 切换开关：PATCH /api/v1/conversations/:conversationId/contact-profile
 *   （后端已支持 agentEnabled 字段；走 conversationId 是为了保持与
 *   现有 contact-profile 端点契约一致，Core 会以 contact 为单位更新）
 *
 * 设计原则：
 * - 搜索匹配：channelDisplayName / channelNickname / channelRemark / sharedAlias
 * - 乐观更新：开关点击后立即本地翻转，失败再回滚并提示
 * - 审计：所有变更调用 Core 走 audit 通道，不在客户端伪造
 */
import { computed, onMounted, ref } from "vue";
import { api } from "../api";
import AvatarImage from "../components/AvatarImage.vue";
import WfIcon from "../components/WfIcon.vue";

type ContactItem = {
  contactId: string;
  conversationId: string;
  channelDisplayName: string | null;
  channelNickname: string | null;
  channelRemark: string | null;
  sharedAlias: string | null;
  avatarUrl: string | null;
  latestMessageAt: string | null;
  latestMessageText: string;
  agentEnabled: boolean;
};

const items = ref<ContactItem[]>([]);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref("");
const nextCursor = ref<string | null>(null);
const searchInput = ref("");
const searchApplied = ref("");
// 切换中：保存 contactId，避免同一条并发翻转
const toggling = ref<Set<string>>(new Set());
// 视图筛选：whitelist = 仅白名单；others = 仅非白名单；all = 全部
const viewFilter = ref<"all" | "whitelist" | "others">("all");

const filteredItems = computed<ContactItem[]>(() => {
  if (viewFilter.value === "whitelist")
    return items.value.filter((item) => item.agentEnabled);
  if (viewFilter.value === "others")
    return items.value.filter((item) => !item.agentEnabled);
  return items.value;
});

function displayName(item: ContactItem): string {
  return (
    item.sharedAlias ||
    item.channelRemark ||
    item.channelNickname ||
    item.channelDisplayName ||
    item.contactId
  );
}

async function load(reset = true) {
  if (reset) {
    loading.value = true;
    items.value = [];
    nextCursor.value = null;
  } else {
    if (loadingMore.value || !nextCursor.value) return;
    loadingMore.value = true;
  }
  error.value = "";
  try {
    const params = new URLSearchParams();
    params.set("limit", "50");
    if (searchApplied.value) params.set("q", searchApplied.value);
    if (!reset && nextCursor.value) params.set("before", nextCursor.value);
    const result = await api<{
      contacts: ContactItem[];
      nextCursor: string | null;
    }>(`/api/v1/contacts?${params.toString()}`);
    if (reset) {
      items.value = result.contacts ?? [];
    } else {
      const seen = new Set(items.value.map((item) => item.contactId));
      items.value = [
        ...items.value,
        ...(result.contacts ?? []).filter((c) => !seen.has(c.contactId)),
      ];
    }
    nextCursor.value = result.nextCursor ?? null;
  } catch (reason) {
    error.value =
      reason instanceof Error ? reason.message : "联系人加载失败";
  } finally {
    if (reset) loading.value = false;
    else loadingMore.value = false;
  }
}

function applySearch() {
  searchApplied.value = searchInput.value.trim();
  void load(true);
}
function clearSearch() {
  searchInput.value = "";
  searchApplied.value = "";
  void load(true);
}

async function toggleAgentEnabled(item: ContactItem) {
  if (toggling.value.has(item.contactId)) return;
  // 乐观更新
  const previous = item.agentEnabled;
  item.agentEnabled = !previous;
  toggling.value.add(item.contactId);
  try {
    await api(
      `/api/v1/conversations/${encodeURIComponent(item.conversationId)}/contact-profile`,
      {
        method: "PATCH",
        body: JSON.stringify({ agentEnabled: item.agentEnabled }),
      },
    );
  } catch (reason) {
    // 回滚
    item.agentEnabled = previous;
    error.value =
      reason instanceof Error ? reason.message : "白名单状态切换失败";
  } finally {
    toggling.value.delete(item.contactId);
  }
}

onMounted(() => {
  void load(true);
});
</script>

<template>
  <div class="wf-service-page">
    <div class="wf-service-head">
      <h1>白名单配置</h1>
      <button class="wf-icon-button" title="刷新" @click="load(true)">
        <WfIcon name="refresh" :size="15" />
      </button>
    </div>
    <div class="wf-whitelist">
      <div class="wf-whitelist-toolbar">
        <div class="wf-search">
          <WfIcon name="search" :size="16" /><input
            v-model="searchInput"
            class="wf-input"
            placeholder="按昵称、备注或共享别名搜索"
            @keyup.enter="applySearch"
          />
        </div>
        <button
          v-if="searchInput"
          class="wf-icon-button"
          title="清空搜索"
          @click="clearSearch"
        >×</button>
        <button
          v-else
          class="wf-icon-button"
          title="搜索"
          @click="applySearch"
        ><WfIcon name="search" :size="16" /></button>
        <div class="wf-whitelist-filter">
          <button
            class="wf-tab"
            :class="{ active: viewFilter === 'all' }"
            @click="viewFilter = 'all'"
          >全部</button>
          <button
            class="wf-tab"
            :class="{ active: viewFilter === 'whitelist' }"
            @click="viewFilter = 'whitelist'"
          >白名单</button>
          <button
            class="wf-tab"
            :class="{ active: viewFilter === 'others' }"
            @click="viewFilter = 'others'"
          >仅人工</button>
        </div>
      </div>
      <div v-if="error" class="wf-error wf-pane-error">
        <span>{{ error }}</span
        ><button class="wf-button compact" @click="load(true)">重试</button>
      </div>
      <div v-if="loading && !items.length" class="wf-queue-loading">
        <div v-for="i in 6" :key="i" class="wx-row">
          <div class="wf-skeleton wf-skeleton-title"></div>
          <div class="wf-skeleton wf-skeleton-line"></div>
        </div>
      </div>
      <div class="wf-whitelist-table" v-else-if="filteredItems.length">
        <div class="wf-whitelist-row wf-whitelist-head">
          <span>联系人</span>
          <span>最近消息</span>
          <span class="wf-whitelist-toggle-col">白名单</span>
        </div>
        <div
          v-for="item in filteredItems"
          :key="item.contactId"
          class="wf-whitelist-row"
        >
          <div class="wf-whitelist-contact">
            <AvatarImage
              :contact-id="item.contactId"
              :fallback-text="displayName(item)"
              :size="32"
            />
            <div class="wf-whitelist-contact-body">
              <strong>{{ displayName(item) }}</strong>
              <span v-if="item.sharedAlias && item.channelRemark" class="wf-muted">
                {{ item.channelRemark }}
              </span>
              <span v-else-if="item.channelDisplayName" class="wf-muted">
                {{ item.channelDisplayName }}
              </span>
            </div>
          </div>
          <div class="wf-whitelist-preview">
            <span>{{ item.latestMessageText || "暂无消息" }}</span>
            <span v-if="item.latestMessageAt" class="wf-muted">{{
              new Date(item.latestMessageAt).toLocaleString()
            }}</span>
          </div>
          <div class="wf-whitelist-toggle-col">
            <label class="wf-switch">
              <input
                type="checkbox"
                :checked="item.agentEnabled"
                :disabled="toggling.has(item.contactId)"
                @change="toggleAgentEnabled(item)"
              />
              <span class="wf-switch-slider"></span>
            </label>
            <span
              class="wf-whitelist-status"
              :class="{ on: item.agentEnabled }"
            >{{ item.agentEnabled ? "白名单" : "仅人工" }}</span>
          </div>
        </div>
        <button
          v-if="nextCursor"
          class="wf-load-more"
          :disabled="loadingMore"
          @click="load(false)"
        >
          {{ loadingMore ? "正在加载…" : "加载更多" }}
        </button>
      </div>
      <div v-else-if="!loading" class="wf-empty">
        <div>
          <strong>{{
            searchApplied ? "没有符合条件的联系人" : "暂无联系人"
          }}</strong>
          <p v-if="!searchApplied">客户首次发消息后将出现在此处。</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wf-whitelist {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.wf-whitelist-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--wf-border, rgba(0, 0, 0, 0.08));
}
.wf-whitelist-toolbar .wf-search {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--wf-border, rgba(0, 0, 0, 0.1));
  border-radius: 999px;
  background: var(--wf-surface, #fff);
}
.wf-whitelist-filter {
  display: inline-flex;
  gap: 4px;
  padding: 2px;
  border: 1px solid var(--wf-border, rgba(0, 0, 0, 0.08));
  border-radius: 8px;
  background: var(--wf-surface, #fff);
}
.wf-whitelist-filter .wf-tab {
  min-height: 24px;
  padding: 2px 10px;
  border: 0;
  background: transparent;
  color: var(--wf-text-secondary, #5f6368);
  font-size: 12px;
  border-radius: 6px;
  cursor: pointer;
}
.wf-whitelist-filter .wf-tab.active {
  background: #e8f0fe;
  color: #1a56c4;
  font-weight: 700;
}
.wf-whitelist-table {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.wf-whitelist-row {
  display: grid;
  grid-template-columns: 240px 1fr 160px;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--wf-border, rgba(0, 0, 0, 0.05));
}
.wf-whitelist-row.wf-whitelist-head {
  font-size: 12px;
  font-weight: 700;
  color: var(--wf-text-tertiary, #9aa0a6);
  background: var(--wf-surface-hover, rgba(0, 0, 0, 0.02));
  position: sticky;
  top: 0;
  z-index: 1;
}
.wf-whitelist-contact {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.wf-whitelist-contact-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.wf-whitelist-contact-body strong {
  font-size: 13px;
  color: var(--wf-text, #17181a);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wf-whitelist-contact-body .wf-muted {
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wf-whitelist-preview {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.wf-whitelist-preview span:first-child {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--wf-text-secondary, #5f6368);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wf-whitelist-preview .wf-muted {
  flex-shrink: 0;
  font-size: 11px;
}
.wf-whitelist-toggle-col {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.wf-whitelist-status {
  font-size: 11px;
  color: var(--wf-text-tertiary, #9aa0a6);
}
.wf-whitelist-status.on {
  color: #137333;
  font-weight: 700;
}
/* switch */
.wf-switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
}
.wf-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.wf-switch-slider {
  position: absolute;
  inset: 0;
  background: #c4c7c5;
  border-radius: 999px;
  transition: background 120ms ease;
  cursor: pointer;
}
.wf-switch-slider::before {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: #fff;
  border-radius: 50%;
  transition: transform 120ms ease;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
}
.wf-switch input:checked + .wf-switch-slider {
  background: #1a56c4;
}
.wf-switch input:checked + .wf-switch-slider::before {
  transform: translateX(16px);
}
.wf-switch input:disabled + .wf-switch-slider {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
