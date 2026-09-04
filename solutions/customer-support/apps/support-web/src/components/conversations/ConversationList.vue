<script setup lang="ts">
/**
 * 会话列表（左栏）：搜索态单列 / 三区工作区 / 联系人页 三种形态。
 * 纯展示组件 —— 数据与选择回调由父级（ConversationsV2）提供。
 */
import { ref, watch } from "vue";
import { RefreshCw, Search, X } from "lucide-vue-next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import AvatarImage from "../AvatarImage.vue";
import {
  contactDisplayName,
} from "../../labels";
import {
  priority,
  riskLabel,
  rowSummary,
  rowTimeLabel,
  type Conversation,
  type SectionScope,
} from "./types";

const props = defineProps<{
  pageMode: "workspace" | "contacts";
  loadingList: boolean;
  listError: string;
  search: string;
  selectedId: string;
  conversationPermissionsEnabled: boolean;
  /** 搜索态/兜底单列 */
  flatConversations: Conversation[];
  /** 三区工作区 */
  queueSections: Array<{
    key: SectionScope;
    title: string;
    tone: string;
    items: Conversation[];
  }>;
  hasMoreConversations: boolean;
  loadingMoreConversations: boolean;
  /** 联系人页 */
  contacts: Array<Record<string, any>>;
  contactsLoading: boolean;
  contactsLoadingMore: boolean;
  contactsError: string;
  contactsNextCursor: string | null;
  contactSearchInput: string;
  contactSearchApplied: string;
  isAdmin: boolean;
}>();

const emit = defineEmits<{
  "update:search": [value: string];
  "update:pageMode": [value: "workspace" | "contacts"];
  select: [conversationId: string];
  "select-contact": [conversationId: string];
  reload: [];
  "load-more": [];
  "load-contacts": [append: boolean];
  "apply-contact-search": [];
  "clear-contact-search": [];
}>();

const localSearch = ref(props.search);
watch(
  () => props.search,
  (value) => (localSearch.value = value),
);
const searchOpen = ref(false);

function isGroup(item: Conversation): boolean {
  return item?.chatType === "group";
}
function contactItemDisplayName(item: Record<string, any>): string {
  return (
    item.sharedAlias ||
    item.channelRemark ||
    item.channelNickname ||
    item.channelDisplayName ||
    item.contactId
  );
}
</script>

<template>
  <aside class="flex min-h-0 flex-col border-r border-border bg-background">
    <!-- 顶栏：刷新 -->
    <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
      <span class="text-sm font-medium">{{ pageMode === "contacts" ? "联系人" : "会话队列" }}</span>
      <Button
        variant="ghost"
        size="icon"
        class="size-7"
        :title="pageMode === 'workspace' ? '刷新队列' : '刷新联系人'"
        @click="emit('reload')"
      >
        <RefreshCw class="size-4" />
      </Button>
    </div>

    <!-- 搜索 / 模式切换 -->
    <div class="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
      <template v-if="searchOpen">
        <div class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-card px-2">
          <Search class="size-3.5 shrink-0 text-muted-foreground" />
          <input
            v-model="localSearch"
            class="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder="联系人、消息或会话 ID"
            @input="emit('update:search', localSearch)"
            @keyup.enter="emit('reload')"
          />
        </div>
        <Button variant="ghost" size="icon" class="size-7" title="收起搜索" @click="searchOpen = false">
          <X class="size-4" />
        </Button>
      </template>
      <template v-else>
        <div class="flex flex-1 items-center gap-0.5 rounded-md border border-border bg-muted p-0.5">
          <button
            class="flex-1 rounded-[5px] px-2 py-1 text-xs transition-colors"
            :class="pageMode === 'workspace' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
            @click="emit('update:pageMode', 'workspace')"
          >
            工作区
          </button>
          <button
            class="flex-1 rounded-[5px] px-2 py-1 text-xs transition-colors"
            :class="pageMode === 'contacts' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
            @click="emit('update:pageMode', 'contacts')"
          >
            联系人
          </button>
        </div>
        <Button variant="ghost" size="icon" class="size-7" title="搜索会话" @click="searchOpen = true">
          <Search class="size-4" />
        </Button>
        <router-link
          v-if="isAdmin"
          to="/whitelist"
          class="inline-flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="白名单配置"
        >
          白名单
        </router-link>
      </template>
    </div>

    <Alert v-if="listError && pageMode === 'workspace'" variant="destructive" class="m-2 items-center border-none">
      <AlertDescription class="flex items-center justify-between gap-2">
        <span class="text-xs">{{ listError }}</span>
        <Button variant="outline" size="sm" class="h-7" @click="emit('reload')">重试</Button>
      </AlertDescription>
    </Alert>

    <!-- ============ 工作区 ============ -->
    <template v-if="pageMode === 'workspace'">
      <div v-if="loadingList" class="space-y-1 p-2">
        <div v-for="i in 6" :key="i" class="flex items-center gap-2.5 px-2 py-2.5">
          <Skeleton class="size-10 shrink-0 rounded-full" />
          <div class="w-full space-y-1.5">
            <Skeleton class="h-3.5 w-2/3" />
            <Skeleton class="h-3 w-full" />
          </div>
        </div>
      </div>

      <!-- 搜索态单列 -->
      <template v-else-if="search">
        <button
          v-for="item in flatConversations"
          :key="item.conversationId"
          class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
          :class="{ 'bg-muted': selectedId === item.conversationId }"
          @click="emit('select', item.conversationId)"
        >
          <AvatarImage
            :contact-id="item.contact?.contactId"
            :fallback-text="contactDisplayName(item)"
            :size="40"
          />
          <span class="min-w-0 flex-1">
            <span class="flex items-center justify-between gap-2">
              <span class="truncate text-sm font-medium">{{ contactDisplayName(item) }}</span>
              <span v-if="isGroup(item)" class="shrink-0 rounded-sm bg-secondary px-1 text-[10px] font-medium text-secondary-foreground">群</span>
              <span class="shrink-0 text-xs text-muted-foreground tabular-nums">
                {{ rowTimeLabel(item.latestMessageAt || item.matchedMessage?.occurredAt) }}
              </span>
            </span>
            <span class="mt-0.5 block truncate text-xs text-muted-foreground">{{ rowSummary(item) }}</span>
          </span>
        </button>
        <div v-if="!flatConversations.length" class="p-6 text-center">
          <p class="text-sm font-medium">没有符合条件的会话</p>
          <p class="mt-1 text-xs text-muted-foreground">调整搜索词后再试。</p>
        </div>
      </template>

      <!-- 三区工作区 -->
      <template v-else-if="conversationPermissionsEnabled">
        <div v-for="section in queueSections" :key="section.key">
          <div class="flex items-center gap-1.5 px-3 pb-1 pt-2.5">
            <span
              class="text-xs font-semibold"
              :class="
                section.tone === 'attention'
                  ? 'text-destructive'
                  : section.tone === 'mine'
                    ? 'text-foreground'
                    : 'text-muted-foreground'
              "
            >{{ section.title }}</span>
            <span class="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-muted px-1 text-[11px] font-medium text-muted-foreground">
              {{ section.items.length }}
            </span>
          </div>
          <button
            v-for="item in section.items"
            :key="item.conversationId"
            class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
            :class="{ 'bg-muted': selectedId === item.conversationId }"
            @click="emit('select', item.conversationId)"
          >
            <AvatarImage
              :contact-id="item.contact?.contactId"
              :fallback-text="contactDisplayName(item)"
              :size="40"
            />
            <span class="min-w-0 flex-1">
              <span class="flex items-center justify-between gap-2">
                <span class="truncate text-sm font-medium">{{ contactDisplayName(item) }}</span>
                <span v-if="isGroup(item)" class="shrink-0 rounded-sm bg-secondary px-1 text-[10px] font-medium text-secondary-foreground">群</span>
                <span
                  v-if="item.handoff?.status === 'pending' || item.riskLevel === 'high'"
                  class="shrink-0 text-xs font-semibold"
                  :class="item.handoff?.status === 'pending' ? 'text-destructive' : 'text-destructive/90'"
                >{{ item.handoff?.status === "pending" ? "待接手" : riskLabel(item.riskLevel) }}</span>
                <span v-else class="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {{ rowTimeLabel(item.latestMessageAt || item.matchedMessage?.occurredAt) }}
                </span>
              </span>
              <span class="mt-0.5 flex items-center justify-between gap-2">
                <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ rowSummary(item) }}</span>
                <span
                  v-if="Number(item.unreadCustomerCount || 0) > 0"
                  class="inline-flex h-[17px] min-w-[17px] shrink-0 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-white"
                >{{ Number(item.unreadCustomerCount) > 99 ? "99+" : item.unreadCustomerCount }}</span>
              </span>
            </span>
          </button>
          <div v-if="!section.items.length" class="px-3 pb-1.5 text-xs text-muted-foreground">暂无</div>
        </div>
        <div v-if="!queueSections.some((s) => s.items.length)" class="p-6 text-center">
          <p class="text-sm font-medium">暂无会话</p>
          <p class="mt-1 text-xs text-muted-foreground">Agent 可以继续自动处理现有会话。</p>
        </div>
        <Button
          v-if="hasMoreConversations"
          variant="ghost"
          size="sm"
          class="mx-auto my-2"
          :disabled="loadingMoreConversations"
          @click="emit('load-more')"
        >
          {{ loadingMoreConversations ? "正在加载…" : "加载更多" }}
        </Button>
      </template>

      <!-- 兜底单列（capability 未开启） -->
      <template v-else>
        <button
          v-for="item in flatConversations"
          :key="item.conversationId"
          class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
          :class="{ 'bg-muted': selectedId === item.conversationId }"
          @click="emit('select', item.conversationId)"
        >
          <AvatarImage
            :contact-id="item.contact?.contactId"
            :fallback-text="contactDisplayName(item)"
            :size="40"
          />
          <span class="min-w-0 flex-1">
            <span class="flex items-center justify-between gap-2">
              <span class="truncate text-sm font-medium">{{ contactDisplayName(item) }}</span>
              <span v-if="isGroup(item)" class="shrink-0 rounded-sm bg-secondary px-1 text-[10px] font-medium text-secondary-foreground">群</span>
              <span class="shrink-0 text-xs text-muted-foreground tabular-nums">
                {{ rowTimeLabel(item.latestMessageAt || item.matchedMessage?.occurredAt) }}
              </span>
            </span>
            <span class="mt-0.5 block truncate text-xs text-muted-foreground">{{ rowSummary(item) }}</span>
          </span>
        </button>
        <div v-if="!flatConversations.length" class="p-6 text-center">
          <p class="text-sm font-medium">暂无会话</p>
          <p class="mt-1 text-xs text-muted-foreground">Agent 可以继续自动处理现有会话。</p>
        </div>
      </template>
    </template>

    <!-- ============ 联系人页 ============ -->
    <template v-else>
      <div class="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <div class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-card px-2">
          <Search class="size-3.5 shrink-0 text-muted-foreground" />
          <input
            :value="contactSearchInput"
            class="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder="按昵称、备注或共享别名搜索"
            @input="emit('update:search', ($event.target as HTMLInputElement).value)"
            @keyup.enter="emit('apply-contact-search')"
          />
        </div>
        <Button v-if="contactSearchInput" variant="ghost" size="icon" class="size-7" title="清空" @click="emit('clear-contact-search')">
          <X class="size-4" />
        </Button>
        <Button v-else variant="ghost" size="icon" class="size-7" title="搜索" @click="emit('apply-contact-search')">
          <Search class="size-4" />
        </Button>
      </div>

      <Alert v-if="contactsError" variant="destructive" class="m-2 items-center border-none">
        <AlertDescription class="flex items-center justify-between gap-2">
          <span class="text-xs">{{ contactsError }}</span>
          <Button variant="outline" size="sm" class="h-7" @click="emit('load-contacts', false)">重试</Button>
        </AlertDescription>
      </Alert>

      <div v-if="contactsLoading && !contacts.length" class="space-y-1 p-2">
        <div v-for="i in 6" :key="i" class="flex items-center gap-2.5 px-2 py-2.5">
          <Skeleton class="size-10 shrink-0 rounded-full" />
          <div class="w-full space-y-1.5">
            <Skeleton class="h-3.5 w-2/3" />
            <Skeleton class="h-3 w-full" />
          </div>
        </div>
      </div>
      <template v-else>
        <button
          v-for="item in contacts"
          :key="item.contactId"
          class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
          :class="{ 'bg-muted': selectedId === item.conversationId }"
          @click="emit('select-contact', item.conversationId)"
        >
          <AvatarImage
            :contact-id="item.contactId"
            :fallback-text="contactItemDisplayName(item)"
            :size="40"
          />
          <span class="min-w-0 flex-1">
            <span class="flex items-center justify-between gap-2">
              <span class="truncate text-sm font-medium">{{ contactItemDisplayName(item) }}</span>
              <span
                v-if="item.agentEnabled"
                class="shrink-0 rounded-sm bg-secondary px-1 text-[10px] font-medium text-secondary-foreground"
                title="Agent 自动回复已开启"
              >白名单</span>
              <span v-else class="shrink-0 text-xs text-muted-foreground">仅人工</span>
            </span>
            <span class="mt-0.5 flex items-center justify-between gap-2">
              <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ item.latestMessageText || "暂无消息" }}</span>
              <span v-if="item.latestMessageAt" class="shrink-0 text-xs text-muted-foreground tabular-nums">
                {{ rowTimeLabel(item.latestMessageAt) }}
              </span>
            </span>
          </span>
        </button>
        <div v-if="!contactsLoading && !contacts.length" class="p-6 text-center">
          <p class="text-sm font-medium">
            {{ contactSearchApplied ? "没有符合条件的联系人" : "暂无联系人" }}
          </p>
          <p v-if="!contactSearchApplied" class="mt-1 text-xs text-muted-foreground">
            客户首次发消息后将出现在此处。
          </p>
        </div>
        <Button
          v-if="contactsNextCursor"
          variant="ghost"
          size="sm"
          class="mx-auto my-2"
          :disabled="contactsLoadingMore"
          @click="emit('load-contacts', true)"
        >
          {{ contactsLoadingMore ? "正在加载…" : "加载更多" }}
        </Button>
      </template>
    </template>
  </aside>
</template>
