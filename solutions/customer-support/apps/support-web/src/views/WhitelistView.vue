<script setup lang="ts">
/**
 * 联系人策略页（admin only）：自动回复 / 仅人工 / 已拉黑。
 *
 * - 列表来源：GET /api/v1/contacts（q + agentEnabled + blocked + 游标分页），
 *   分页/去重/搜索由 use-contact-list 提供（与工作台共用同一实现）
 * - 切换策略：PATCH /api/v1/conversations/:conversationId/contact-profile
 *   （Core 以 contact 为单位更新）
 *
 * 黑名单制（0078 起）：新联系人默认由 AI 接待（agentEnabled=true）；
 * 拉黑（blocked=true）比「仅人工」更强——不进会话列表、不推通知。
 *
 * 设计原则：
 * - 搜索匹配：channelDisplayName / channelNickname / channelRemark / sharedAlias
 * - 乐观更新：选择后立即本地翻转，失败再回滚并提示
 * - 审计：所有变更调用 Core 走 audit 通道，不在客户端伪造
 */
import { computed, onMounted, ref, watch } from "vue";
import { Loader2, RefreshCw, Search, X } from "lucide-vue-next";
import { api } from "../api";
import AvatarImage from "../components/AvatarImage.vue";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { useContactList } from "../composables/use-contact-list";
import type { ContactListFilter, ContactSummary } from "../composables/use-contact-list";

/** 联系人策略：三态互斥（AI 自动回复 / 仅人工 / 已拉黑） */
type ContactPolicy = "agent" | "manual" | "blocked";

const searchInput = ref("");
const searchApplied = ref("");
// 切换中：保存 contactId，避免同一条并发翻转
const toggling = ref<Set<string>>(new Set());
// 视图筛选：与服务端过滤一致（all = 不过滤）
const viewFilter = ref<"all" | ContactPolicy>("all");

const {
  contacts: items,
  loading,
  loadingMore,
  error,
  nextCursor,
  load: loadContacts,
} = useContactList({
  getQuery: () => searchApplied.value,
  getFilter: () => filterOf(viewFilter.value),
});

function filterOf(view: "all" | ContactPolicy): ContactListFilter {
  if (view === "agent") return { agentEnabled: true, blocked: false };
  if (view === "manual") return { agentEnabled: false, blocked: false };
  if (view === "blocked") return { blocked: true };
  return {};
}

function policyOf(item: ContactSummary): ContactPolicy {
  if (item.blocked) return "blocked";
  return item.agentEnabled ? "agent" : "manual";
}

function matchesFilter(item: ContactSummary, view: "all" | ContactPolicy): boolean {
  if (view === "all") return true;
  return policyOf(item) === view;
}

const policyLabels: Record<ContactPolicy, string> = {
  agent: "AI 自动回复",
  manual: "仅人工",
  blocked: "已拉黑",
};

function displayName(item: ContactSummary): string {
  return (
    item.sharedAlias ||
    item.channelRemark ||
    item.channelNickname ||
    item.channelDisplayName ||
    item.contactId
  );
}

function applySearch() {
  searchApplied.value = searchInput.value.trim();
  void loadContacts(false);
}
function clearSearch() {
  searchInput.value = "";
  searchApplied.value = "";
  void loadContacts(false);
}

// 切 Tab 走服务端过滤（此前是客户端过滤，翻页后计数与成员会错位）
watch(viewFilter, () => {
  void loadContacts(false);
});

async function setPolicy(item: ContactSummary, policy: ContactPolicy) {
  if (toggling.value.has(item.contactId)) return;
  if (policyOf(item) === policy) return;
  // 乐观更新
  const previousEnabled = item.agentEnabled;
  const previousBlocked = item.blocked;
  item.blocked = policy === "blocked";
  item.agentEnabled = policy === "agent";
  toggling.value.add(item.contactId);
  try {
    const body =
      policy === "blocked"
        ? { blocked: true }
        : { agentEnabled: policy === "agent", blocked: false };
    await api(
      `/api/v1/conversations/${encodeURIComponent(item.conversationId)}/contact-profile`,
      { method: "PATCH", body: JSON.stringify(body) },
    );
    // 变更后若不再符合当前筛选（如「已拉黑」页里改为自动回复），从列表移除
    if (!matchesFilter(item, viewFilter.value)) {
      items.value = items.value.filter((row) => row.contactId !== item.contactId);
    }
  } catch (reason) {
    // 回滚
    item.agentEnabled = previousEnabled;
    item.blocked = previousBlocked;
    error.value = reason instanceof Error ? reason.message : "联系人策略切换失败";
  } finally {
    toggling.value.delete(item.contactId);
  }
}

const activeTab = computed({
  get: () => viewFilter.value,
  set: (value: string) => {
    viewFilter.value = value as "all" | ContactPolicy;
  },
});

onMounted(() => {
  void loadContacts(false);
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
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
        @click="loadContacts(false)"
      >
        <RefreshCw class="size-4" />
      </Button>
      <Tabs v-model="activeTab">
        <TabsList>
          <TabsTrigger value="all">全部</TabsTrigger>
          <TabsTrigger value="agent">自动回复</TabsTrigger>
          <TabsTrigger value="manual">仅人工</TabsTrigger>
          <TabsTrigger value="blocked">已拉黑</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>

    <div v-if="error" class="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
      <p class="text-sm text-destructive" role="alert">{{ error }}</p>
      <Button variant="outline" size="sm" @click="loadContacts(false)">重试</Button>
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

    <div v-else-if="items.length" class="min-h-0 flex-1 overflow-auto">
      <div class="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_168px] items-center gap-3 border-b border-border bg-muted/60 px-4 py-2 text-xs font-medium text-muted-foreground">
        <span>联系人</span>
        <span class="text-right">策略</span>
      </div>
      <div
        v-for="item in items"
        :key="item.contactId"
        class="grid grid-cols-[minmax(0,1fr)_168px] items-center gap-3 border-b border-border px-4 py-2 transition-colors last:border-b-0 hover:bg-muted/50"
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
        <div class="flex items-center justify-end gap-2">
          <Loader2
            v-if="toggling.has(item.contactId)"
            class="size-3.5 animate-spin text-muted-foreground"
          />
          <select
            :value="policyOf(item)"
            :disabled="toggling.has(item.contactId)"
            :aria-label="`联系人策略：${displayName(item)}`"
            class="h-9 rounded-md border border-input bg-background px-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
            @change="setPolicy(item, ($event.target as HTMLSelectElement).value as ContactPolicy)"
          >
            <option value="agent">{{ policyLabels.agent }}</option>
            <option value="manual">{{ policyLabels.manual }}</option>
            <option value="blocked">{{ policyLabels.blocked }}</option>
          </select>
        </div>
      </div>
      <div v-if="nextCursor" class="flex justify-center py-4">
        <Button variant="outline" size="sm" :disabled="loadingMore" @click="loadContacts(true)">
          {{ loadingMore ? "正在加载…" : "加载更多" }}
        </Button>
      </div>
    </div>

    <div
      v-else-if="!loading"
      class="flex flex-1 flex-col items-center justify-center gap-1 p-12 text-muted-foreground"
    >
      <p class="text-sm font-medium text-foreground">
        {{ searchApplied || viewFilter !== "all" ? "没有符合条件的联系人" : "暂无联系人" }}
      </p>
      <p v-if="!searchApplied && viewFilter === 'all'" class="text-sm">
        客户首次发消息后将出现在此处。
      </p>
    </div>
  </div>
</template>
