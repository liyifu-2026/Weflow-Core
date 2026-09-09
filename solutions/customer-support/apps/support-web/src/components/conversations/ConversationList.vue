<script setup lang="ts">
/**
 * 会话列表（左栏）。
 *
 * 搜索合一（UX-DECISIONS §1）：单一搜索框——
 * - 空态：三区工作区（等待处理 / 我处理的 / 其他对话）或兜底单列；
 * - 输入：同时搜索会话与全部联系人，分组展示；点击联系人即打开其会话。
 * 白名单配置入口在「管理」页（此处不再重复）。
 */
import { ref, watch } from "vue";
import { RefreshCw, Search, X } from "lucide-vue-next";
import AvatarImage from "../AvatarImage.vue";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { contactDisplayName } from "../../labels";
import {
  rowSummary,
  rowTimeLabel,
  riskLabel,
  type Conversation,
  type SectionScope,
} from "./types";

const props = defineProps<{
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
  /** 搜索态的联系人分组 */
  contacts: Array<Record<string, any>>;
  contactsLoading: boolean;
  contactsLoadingMore: boolean;
  contactsError: string;
  contactsNextCursor: string | null;
}>();

const emit = defineEmits<{
  "update:search": [value: string];
  select: [conversationId: string];
  "select-contact": [conversationId: string];
  reload: [];
  "load-more": [];
  "load-contacts": [append: boolean];
}>();

const localSearch = ref(props.search);
watch(
  () => props.search,
  (value) => (localSearch.value = value),
);

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
    <!-- 顶栏：标题 + 刷新 -->
    <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
      <span class="text-sm font-medium">{{ search ? "搜索结果" : "会话队列" }}</span>
      <Button
        variant="ghost"
        size="icon"
        class="size-7"
        title="刷新"
        @click="emit('reload')"
      >
        <RefreshCw class="size-4" />
      </Button>
    </div>

    <!-- 单一搜索框：空态为队列，输入同搜会话与联系人 -->
    <div class="border-b border-border px-2 py-1.5">
      <div class="flex items-center gap-1.5 rounded-md bg-muted px-2">
        <Search class="size-3.5 shrink-0 text-muted-foreground" />
        <input
          v-model="localSearch"
          class="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder="搜索会话或联系人"
          @input="emit('update:search', localSearch)"
        />
        <Button
          v-if="localSearch"
          variant="ghost"
          size="icon"
          class="size-6 shrink-0"
          title="清空"
          @click="((localSearch = ''), emit('update:search', ''))"
        >
          <X class="size-3.5" />
        </Button>
      </div>
    </div>

    <Alert v-if="listError && !search" variant="destructive" class="m-2 items-center border-none">
      <AlertDescription class="flex items-center justify-between gap-2">
        <span class="text-xs">{{ listError }}</span>
        <Button variant="outline" size="sm" class="h-7" @click="emit('reload')">重试</Button>
      </AlertDescription>
    </Alert>

    <!-- ============ 搜索态：会话 + 联系人分组 ============ -->
    <div v-if="search" class="min-h-0 flex-1 overflow-y-auto">
      <div class="px-3 pb-1 pt-2.5 text-xs font-semibold text-muted-foreground">会话</div>
      <template v-if="loadingList">
        <div v-for="i in 3" :key="i" class="flex items-center gap-2.5 px-3 py-2.5">
          <Skeleton class="size-10 shrink-0 rounded-full" />
          <div class="w-full space-y-1.5">
            <Skeleton class="h-3.5 w-2/3" />
            <Skeleton class="h-3 w-full" />
          </div>
        </div>
      </template>
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
        <div v-if="!flatConversations.length" class="px-3 pb-2 text-xs text-muted-foreground">没有符合条件的会话</div>
      </template>

      <div class="border-t border-border px-3 pb-1 pt-2.5 text-xs font-semibold text-muted-foreground">全部联系人</div>
      <Alert v-if="contactsError" variant="destructive" class="m-2 items-center border-none">
        <AlertDescription class="flex items-center justify-between gap-2">
          <span class="text-xs">{{ contactsError }}</span>
          <Button variant="outline" size="sm" class="h-7" @click="emit('load-contacts', false)">重试</Button>
        </AlertDescription>
      </Alert>
      <template v-if="contactsLoading && !contacts.length">
        <div v-for="i in 3" :key="i" class="flex items-center gap-2.5 px-3 py-2.5">
          <Skeleton class="size-10 shrink-0 rounded-full" />
          <div class="w-full space-y-1.5">
            <Skeleton class="h-3.5 w-2/3" />
            <Skeleton class="h-3 w-full" />
          </div>
        </div>
      </template>
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
        <div v-if="!contacts.length" class="px-3 pb-2 text-xs text-muted-foreground">没有符合条件的联系人</div>
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
    </div>

    <!-- ============ 队列态 ============ -->
    <div v-else class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="loadingList" class="space-y-1 p-2">
        <div v-for="i in 6" :key="i" class="flex items-center gap-2.5 px-2 py-2.5">
          <Skeleton class="size-10 shrink-0 rounded-full" />
          <div class="w-full space-y-1.5">
            <Skeleton class="h-3.5 w-2/3" />
            <Skeleton class="h-3 w-full" />
          </div>
        </div>
      </div>

      <!-- 三区工作区 -->
      <template v-else-if="conversationPermissionsEnabled">
        <div v-for="section in queueSections" :key="section.key">
          <div class="flex items-center gap-1.5 px-3 pb-1 pt-2.5">
            <!-- Zinc 克制：待办分区用 foreground 强调，destructive 红仅留给错误/危险 -->
            <span
              class="text-xs font-semibold"
              :class="section.tone === 'others' ? 'text-muted-foreground' : 'text-foreground'"
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
                  class="shrink-0 text-xs font-semibold text-foreground"
                >{{ item.handoff?.status === "pending" ? "待接手" : riskLabel(item.riskLevel) }}</span>
                <span v-else class="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {{ rowTimeLabel(item.latestMessageAt || item.matchedMessage?.occurredAt) }}
                </span>
              </span>
              <span class="mt-0.5 flex items-center justify-between gap-2">
                <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ rowSummary(item) }}</span>
                <span
                  v-if="Number(item.unreadCustomerCount || 0) > 0"
                  class="inline-flex h-[17px] min-w-[17px] shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
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
    </div>
  </aside>
</template>
