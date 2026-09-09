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
import { Loader2, RefreshCw, Search, X } from "lucide-vue-next";
import { api } from "../api";
import AvatarImage from "../components/AvatarImage.vue";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";

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

/**
 * 最近消息展示兜底（ISS-003）：上游消息原文可能含 HTML 片段或以内部
 * user_id 开头/整条就是内部 id（ISS C-1），列表里只做纯文本摘要——
 * 剥标签、隐藏内部 id、超长截断。原文以详情/会话页为准。
 */
function latestMessageSummary(text: string): string {
  const stripped = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (/^user_[A-Za-z0-9]+/.test(stripped)) return "消息内容暂不可见";
  return stripped.length > 60 ? `${stripped.slice(0, 60)}…` : stripped;
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
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
      <div class="relative min-w-0 flex-1">
        <Search
          class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          v-model="searchInput"
          class="pl-9 pr-8"
          placeholder="按昵称、备注或共享别名搜索"
          @keyup.enter="applySearch"
        />
        <Button
          v-if="searchInput"
          variant="ghost"
          size="icon"
          class="absolute right-1 top-1/2 size-7 -translate-y-1/2"
          title="清空搜索"
          aria-label="清空搜索"
          @click="clearSearch"
        >
          <X class="size-4" />
        </Button>
      </div>
      <Button
        variant="ghost"
        size="icon"
        title="刷新"
        aria-label="刷新"
        @click="load(true)"
      >
        <RefreshCw class="size-4" />
      </Button>
      <Tabs v-model="viewFilter">
        <TabsList>
          <TabsTrigger value="all">全部</TabsTrigger>
          <TabsTrigger value="whitelist">白名单</TabsTrigger>
          <TabsTrigger value="others">仅人工</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>

    <div v-if="error" class="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
      <p class="text-sm text-destructive" role="alert">{{ error }}</p>
      <Button variant="outline" size="sm" @click="load(true)">重试</Button>
    </div>

    <div v-if="loading && !items.length" class="space-y-2 p-4">
      <div v-for="i in 6" :key="i" class="flex items-center gap-3">
        <Skeleton class="size-8 rounded-full" />
        <div class="flex-1 space-y-1.5">
          <Skeleton class="h-4 w-1/4" />
          <Skeleton class="h-3 w-1/2" />
        </div>
      </div>
    </div>

    <div v-else-if="filteredItems.length" class="min-h-0 flex-1 overflow-auto">
      <div class="sticky top-0 z-10 grid grid-cols-[minmax(160px,240px)_minmax(0,1fr)_140px] items-center gap-3 border-b border-border bg-muted/60 px-4 py-2 text-xs font-medium text-muted-foreground">
        <span>联系人</span>
        <span>最近消息</span>
        <span class="text-right">白名单</span>
      </div>
      <div
        v-for="item in filteredItems"
        :key="item.contactId"
        class="grid grid-cols-[minmax(160px,240px)_minmax(0,1fr)_140px] items-center gap-3 border-b border-border px-4 py-2 transition-colors last:border-b-0 hover:bg-muted/50"
      >
        <div class="flex min-w-0 items-center gap-2.5">
          <AvatarImage
            :contact-id="item.contactId"
            :fallback-text="displayName(item)"
            :size="32"
          />
          <div class="min-w-0 leading-tight">
            <p class="truncate text-sm">{{ displayName(item) }}</p>
            <p
              v-if="(item.sharedAlias && item.channelRemark) || item.channelDisplayName"
              class="truncate text-xs text-muted-foreground"
            >
              {{ item.sharedAlias && item.channelRemark ? item.channelRemark : item.channelDisplayName }}
            </p>
          </div>
        </div>
        <div class="flex min-w-0 items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {{ item.latestMessageText ? latestMessageSummary(item.latestMessageText) : "暂无消息" }}
          </span>
          <span v-if="item.latestMessageAt" class="shrink-0 text-xs text-muted-foreground">
            {{ new Date(item.latestMessageAt).toLocaleString() }}
          </span>
        </div>
        <div class="flex items-center justify-end gap-2">
          <Switch
            :model-value="item.agentEnabled"
            :disabled="toggling.has(item.contactId)"
            :aria-label="`白名单开关：${displayName(item)}`"
            @update:model-value="toggleAgentEnabled(item)"
          />
          <Loader2
            v-if="toggling.has(item.contactId)"
            class="size-3.5 animate-spin text-muted-foreground"
          />
          <span v-else class="w-14 text-right text-xs" :class="item.agentEnabled ? 'font-medium' : 'text-muted-foreground'">
            {{ item.agentEnabled ? "白名单" : "仅人工" }}
          </span>
        </div>
      </div>
      <div v-if="nextCursor" class="flex justify-center py-4">
        <Button variant="outline" size="sm" :disabled="loadingMore" @click="load(false)">
          {{ loadingMore ? "正在加载…" : "加载更多" }}
        </Button>
      </div>
    </div>

    <div
      v-else-if="!loading"
      class="flex flex-1 flex-col items-center justify-center gap-1 p-12 text-muted-foreground"
    >
      <p class="text-sm font-medium text-foreground">
        {{ searchApplied ? "没有符合条件的联系人" : "暂无联系人" }}
      </p>
      <p v-if="!searchApplied" class="text-sm">客户首次发消息后将出现在此处。</p>
    </div>
  </div>
</template>
