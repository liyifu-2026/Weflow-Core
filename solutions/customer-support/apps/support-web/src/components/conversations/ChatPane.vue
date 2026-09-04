<script setup lang="ts">
/**
 * 聊天窗格（中栏）：线程头（联系人/操作菜单/任务行）+ 消息滚动区 +
 * 「AI 正在思考」气泡 + wait 时间线节点 + 新消息提示 + 接管条/输入区。
 * 状态与动作全部由父级注入，本组件不持有业务状态。
 */
import { computed, ref } from "vue";
import { Ellipsis, ArrowDown, Loader2 } from "lucide-vue-next";
import { useRoute } from "vue-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import AvatarImage from "../AvatarImage.vue";
import MessageBubble from "./MessageBubble.vue";
import Composer from "./Composer.vue";
import HandoffBar from "./HandoffBar.vue";
import { contactDisplayName } from "../../labels";
import {
  isFileMessage,
  isImageMessage,
  isVoiceMsg,
  messageTime,
  riskLabel,
  sendStateLabel,
  type Conversation,
  type Message,
} from "./types";

const props = defineProps<{
  selected: Conversation | null;
  selectedIsGroup: boolean;
  company: string;
  loadingConversation: boolean;
  detailError: string;
  messages: Message[];
  /** 会话状态徽章（Phase 3 session episode） */
  sessionBadgeLabel: string | null;
  /** 「AI 正在思考」实时状态 */
  liveThinking: { turnId: string; status: string; startedAt?: string; lastEventLabel?: string; reasoning?: string | null } | null;
  /** wait 时间线 */
  pendingWake: { wakeId: number; turnId: string; kind: string; status: string; wakeAt: string; nudgeText?: string | null } | null;
  agentSessionWaiting: boolean;
  wakeCountdown: string;
  doneWakes: Array<{ wakeId: number; turnId: string; kind: string; status: string; wakeAt: string; nudgeText?: string | null }>;
  /** 滚动跟随 */
  atBottom: boolean;
  newMessageCount: number;
  nextCursor: string | null;
  loadingOlder: boolean;
  loadingMoreFlag: boolean;
  /** 接管/操作 */
  canManualTakeover: boolean;
  takeoverTransition: boolean;
  actionBusy: boolean;
  briefingLine: string;
  canTransfer: boolean;
  canFinish: boolean;
  handoffStatus: string | undefined;
  transferPendingLabel: string | null;
  canRejectTransfer: boolean;
  /** Composer */
  replyText: string;
  sending: boolean;
  canReply: boolean;
  isMine: boolean;
  mediaUploading: boolean;
  toolHint: string;
  replyTarget: Message | null;
  mentionContacts: Array<{ id: string; name: string }>;
  composerPlaceholder: string;
  composerDisabled: boolean;
  retryBusy: boolean;
  outcomeBusy: boolean;
}>();

const emit = defineEmits<{
  "open-customer": [];
  "open-settings": [];
  "open-transfer": [];
  "open-profile": [];
  takeover: [];
  resolve: [];
  "reject-transfer": [];
  "reload-detail": [];
  "load-older": [];
  "jump-latest": [];
  "scroll": [];
  "update:replyText": [value: string];
  send: [];
  "pick-image": [];
  "pick-file": [];
  "open-assets": [];
  "clear-reply": [];
  "message-contextmenu": [event: MouseEvent, message: Message];
  "avatar-contextmenu": [event: MouseEvent, message: Message];
  "retry-message": [message: Message];
  "check-outcome": [message: Message];
  "open-trace": [turnId: string];
}>();

const route = useRoute();
const messagePane = ref<HTMLElement | null>(null);

/** 无限滚动：滚近顶部自动加载更早；同时向父级同步 atBottom 状态 */
function onPaneScroll() {
  emit("scroll");
  const pane = messagePane.value;
  if (!pane) return;
  if (pane.scrollTop <= 48 && props.nextCursor && !props.loadingOlder && !props.loadingConversation) {
    emit("load-older");
  }
}
defineExpose({ messagePane });

const selectedDisplay = computed(() =>
  props.selected ? contactDisplayName(props.selected) : "",
);

function onComposerTextUpdate(value: string) {
  emit("update:replyText", value);
}
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-col overflow-hidden">
    <!-- 线程头 -->
    <template v-if="selected">
      <div class="border-b border-border px-4 py-2">
        <div class="flex items-center justify-between gap-3">
          <div class="flex min-w-0 items-baseline gap-2">
            <AvatarImage
              :contact-id="selected.contact?.contactId"
              :fallback-text="selectedDisplay"
              :size="32"
              class="self-center"
            />
            <button
              class="flex min-w-0 items-baseline gap-2 text-left transition-colors hover:[&>strong]:underline"
              title="查看客户资料"
              @click="emit('open-customer')"
            >
              <strong class="truncate text-sm">{{ selectedDisplay }}</strong>
              <span v-if="selectedIsGroup" class="truncate text-xs text-muted-foreground">· 群聊</span>
              <span v-else-if="company" class="truncate text-xs text-muted-foreground">· {{ company }}</span>
            </button>
            <span
              v-if="selected.riskLevel === 'high' || selected.riskLevel === 'medium'"
              class="shrink-0 text-xs"
              :class="selected.riskLevel === 'high' ? 'font-semibold text-destructive' : 'text-muted-foreground'"
            >{{ riskLabel(selected.riskLevel) }}</span>
            <Badge v-if="sessionBadgeLabel" variant="secondary" class="shrink-0">{{ sessionBadgeLabel }}</Badge>
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            <Button
              v-if="canManualTakeover || handoffStatus === 'pending'"
              size="sm"
              :disabled="actionBusy"
              @click="emit(canManualTakeover ? 'takeover' : 'takeover')"
            >
              接手处理
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="icon" class="size-7" title="更多操作">
                  <Ellipsis class="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem @click="emit('open-profile')">个人资料</DropdownMenuItem>
                <DropdownMenuItem v-if="canTransfer" @click="emit('open-transfer')">转交处理</DropdownMenuItem>
                <DropdownMenuItem @click="emit('open-settings')">会话设置</DropdownMenuItem>
                <DropdownMenuSeparator v-if="canFinish" />
                <DropdownMenuItem
                  v-if="canFinish"
                  class="text-destructive focus:text-destructive"
                  @click="emit('resolve')"
                >
                  结束人工处理
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <p class="mt-0.5 truncate text-xs text-muted-foreground" :title="briefingLine">{{ briefingLine }}</p>
        <p v-if="transferPendingLabel" class="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
          <span>{{ transferPendingLabel }}</span>
          <button
            v-if="canRejectTransfer"
            class="text-primary underline-offset-4 hover:underline"
            :disabled="actionBusy"
            @click="emit('reject-transfer')"
          >
            拒绝转交
          </button>
        </p>
      </div>

      <Alert v-if="detailError" variant="destructive" class="m-2 items-center border-none">
        <AlertDescription class="flex items-center justify-between gap-3">
          <span class="text-xs">{{ detailError }}</span>
          <Button variant="outline" size="sm" @click="emit('reload-detail')">重新加载</Button>
        </AlertDescription>
      </Alert>

      <!-- 消息滚动区：滚到顶自动加载更早（无限滚动） -->
      <div
        ref="messagePane"
        class="min-h-0 flex-1 overflow-auto px-5 py-4"
        @scroll="onPaneScroll"
      >
        <div v-if="loadingOlder" class="mb-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 class="size-3.5 animate-spin" />
          正在加载更早的消息…
        </div>

        <template v-if="loadingConversation">
          <div v-for="i in 4" :key="i" class="my-3 flex" :class="i % 2 === 0 ? 'justify-end' : ''">
            <Skeleton class="inline-block h-9 min-w-44 rounded-xl" />
          </div>
        </template>
        <template v-else>
          <MessageBubble
            v-for="message in messages"
            :key="message.messageId"
            :message="message"
            :is-group="selectedIsGroup"
            :contact-id="selected?.contact?.contactId"
            :contact-fallback-name="selectedDisplay"
            :highlighted="route.query.messageId === message.messageId"
            :messages="messages"
            :retry-busy="retryBusy"
            :outcome-busy="outcomeBusy"
            @contextmenu="(event, m) => emit('message-contextmenu', event, m)"
            @avatar-contextmenu="(event, m) => emit('avatar-contextmenu', event, m)"
            @retry="(m) => emit('retry-message', m)"
            @check-outcome="(m) => emit('check-outcome', m)"
          />

          <!-- 「AI 正在思考」气泡 -->
          <div v-if="liveThinking" class="my-3 flex">
            <div class="max-w-[78%] rounded-lg border border-border bg-card px-3.5 py-2.5 shadow-sm">
              <div class="flex items-center gap-2">
                <span class="inline-flex gap-0.5">
                  <i class="size-1.5 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:0ms]" />
                  <i class="size-1.5 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:150ms]" />
                  <i class="size-1.5 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:300ms]" />
                </span>
                <span class="text-sm font-medium text-muted-foreground">{{ liveThinking.lastEventLabel }}</span>
              </div>
              <details v-if="liveThinking.reasoning" class="mt-2 border-t border-dashed border-border pt-1.5">
                <summary class="cursor-pointer select-none text-xs text-muted-foreground">思考过程</summary>
                <pre class="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{{ liveThinking.reasoning }}</pre>
              </details>
            </div>
          </div>

          <!-- wait 时间线节点 -->
          <div
            v-if="pendingWake && agentSessionWaiting"
            class="my-2 flex justify-center"
          >
            <div class="inline-flex items-center gap-2 rounded-full border border-dashed border-border bg-muted/50 px-3.5 py-1.5 text-xs text-muted-foreground">
              <span class="size-2 animate-pulse rounded-full bg-muted-foreground" />
              <span>等待客户回复 · 超时（{{ wakeCountdown }}）后{{ pendingWake.nudgeText ? "自动发送提醒" : "自动唤醒跟进" }}</span>
              <button class="text-primary underline-offset-4 hover:underline" type="button" @click="emit('open-trace', pendingWake.turnId)">
                决策轨迹 →
              </button>
            </div>
          </div>
          <div
            v-for="wake in doneWakes"
            :key="`wake-${wake.wakeId}`"
            class="my-2 flex justify-center"
          >
            <div class="inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3.5 py-1.5 text-xs text-muted-foreground">
              <span class="size-2 rounded-full bg-muted-foreground/50" />
              <span>{{ wake.nudgeText ? "已自动发送提醒" : "已唤醒跟进" }} · {{ messageTime(wake.wakeAt) }}</span>
              <button class="text-primary underline-offset-4 hover:underline" type="button" @click="emit('open-trace', wake.turnId)">
                决策轨迹 →
              </button>
            </div>
          </div>
        </template>
      </div>

      <!-- 新消息提示 -->
      <button
        v-if="!atBottom && newMessageCount > 0"
        class="absolute bottom-24 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-md transition-colors hover:bg-primary/90"
        @click="emit('jump-latest')"
      >
        有 {{ newMessageCount }} 条新消息 <ArrowDown class="size-3" />
      </button>

      <!-- 接管条 or Composer -->
      <HandoffBar
        v-if="canManualTakeover"
        :entering="takeoverTransition"
        :action-busy="actionBusy"
        @takeover="emit('takeover')"
      />
      <Composer
        v-else
        :text="replyText"
        :tool-hint="toolHint"
        @update:text="onComposerTextUpdate($event as string)"
        :entering="takeoverTransition"
        :mention-contacts="mentionContacts"
        :placeholder="composerPlaceholder"
        :disabled="composerDisabled"
        :sending="sending"
        :can-reply="canReply"
        :is-mine="isMine"
        :media-uploading="mediaUploading"
        :reply-target="replyTarget"
        @send="emit('send')"
        @pick-image="emit('pick-image')"
        @pick-file="emit('pick-file')"
        @open-assets="emit('open-assets')"
        @clear-reply="emit('clear-reply')"
      />
    </template>

    <!-- 未选中会话 -->
    <div v-else class="flex flex-1 items-center justify-center p-8">
      <div class="text-center">
        <p class="text-sm font-medium">选择一个会话开始处理</p>
        <p class="mt-1 text-sm text-muted-foreground">队列已按风险、等待状态和未读消息排序。</p>
      </div>
    </div>
  </section>
</template>
