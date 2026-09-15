<script setup lang="ts">
/**
 * 聊天窗格（中栏）：线程头（联系人/操作菜单/任务行）+ 消息滚动区 +
 * 回合侧轨（每点一回合：AI 轮/人工轮/唤醒）+「AI 正在思考」瘦身胶囊 +
 * wait 时间线节点 + 新消息提示 + 接管条/输入区。
 * 状态与动作全部由父级注入，本组件不持有业务状态。
 */
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from "vue";
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
import TurnRail from "./TurnRail.vue";
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
  type RailRound,
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
  /** 轮次体检（回合气泡数据源）：每轮结果概要 + 计数 + 孤儿入站 */
  turnHealth: {
    counts: { replied: number; no_reply: number; failed: number; in_flight: number };
    outcomes: Array<{
      turnId: string;
      status: string;
      errorCode: string | null;
      startedAt: string | null;
      completedAt: string | null;
      durationMs: number | null;
      triggerMessageId: string | null;
      replyBatchId: string | null;
      outcome: string;
    }>;
    orphans: Array<{ messageId: string; contentType: string; text: string; occurredAt: string }>;
    orphanCount: number;
  } | null;
  /** handoff 上下文（人工回合数据源：cycles 含 acceptedAt/resolvedAt/assignedUserId/reason） */
  handoff: {
    cycles?: Array<Record<string, any>>;
    state?: Record<string, any>;
  } | null;
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

// 已耗时显示（THINKING 修复）：让等待可视化，避免"是不是卡了"的焦虑
const nowTick = ref(Date.now());
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
watch(
  () => Boolean(props.liveThinking),
  (active) => {
    if (active && !elapsedTimer) {
      nowTick.value = Date.now();
      elapsedTimer = setInterval(() => (nowTick.value = Date.now()), 1_000);
    } else if (!active && elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  },
);
onUnmounted(() => {
  if (elapsedTimer) clearInterval(elapsedTimer);
});
const liveElapsedText = computed(() => {
  const startedAt = props.liveThinking?.startedAt;
  if (!startedAt) return "";
  const seconds = Math.max(
    0,
    Math.floor((nowTick.value - new Date(startedAt).getTime()) / 1_000),
  );
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
});

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "";
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m${seconds}s`;
}

// ---------- 回合侧轨（TurnRail）数据组装 ----------
// 回合定义：AI 轮 = turn-outcomes（trigger→reply 批次）；人工轮 = handoff
// cycle 被接受（acceptedAt）到 resolvedAt；已完成唤醒作为空心点附在时间线。

const mentionNameById = computed(() => {
  const map = new Map<string, string>();
  for (const item of props.mentionContacts) map.set(item.id, item.name);
  return map;
});

function textExcerpt(text: string | undefined | null, max: number): string {
  const trimmed = (text || "").trim();
  if (!trimmed) return "";
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** 时间线上第一条不早于该时刻的消息（与旧唤醒锚定同规则） */
function firstMessageAfter(iso: string): Message | undefined {
  const at = new Date(iso).getTime();
  return props.messages.find(
    (message) => new Date(message.occurredAt).getTime() >= at,
  );
}

const railRounds = computed<RailRound[]>(() => {
  const rounds: RailRound[] = [];

  // —— AI 回合：轮次体检结果（含进行中）——
  const outcomes = [...(props.turnHealth?.outcomes ?? [])].sort(
    (a, b) =>
      new Date(a.startedAt ?? 0).getTime() - new Date(b.startedAt ?? 0).getTime(),
  );
  for (const outcome of outcomes) {
    const live =
      outcome.outcome === "in_flight" &&
      props.liveThinking?.turnId === outcome.turnId
        ? props.liveThinking
        : null;
    const trigger = outcome.triggerMessageId
      ? props.messages.find((m) => m.messageId === outcome.triggerMessageId)
      : undefined;
    const lastReply = outcome.replyBatchId
      ? [...props.messages]
          .reverse()
          .find((m) => m.replyBatchId === outcome.replyBatchId)
      : undefined;
    const anchor =
      (trigger && props.messages.includes(trigger) ? trigger.messageId : null) ??
      (outcome.replyBatchId
        ? (props.messages.find((m) => m.replyBatchId === outcome.replyBatchId)
            ?.messageId ?? null)
        : null);
    const lines: string[] = [];
    if (outcome.startedAt) lines.push(`开始于 ${messageTime(outcome.startedAt)}`);
    if (live) {
      lines.push(
        `${live.lastEventLabel ?? "正在处理…"}${liveElapsedText.value ? ` · ${liveElapsedText.value}` : ""}`,
      );
    } else if (outcome.durationMs !== null && outcome.durationMs !== undefined) {
      lines.push(`耗时 ${formatDuration(outcome.durationMs)}`);
    }
    if (outcome.errorCode) lines.push(`错误：${outcome.errorCode}`);
    rounds.push({
      key: `agent-${outcome.turnId}`,
      kind: "agent",
      tone:
        outcome.outcome === "replied"
          ? "ok"
          : outcome.outcome === "failed"
            ? "error"
            : outcome.outcome === "in_flight"
              ? "running"
              : "warn",
      title:
        outcome.outcome === "replied"
          ? "AI 回复"
          : outcome.outcome === "failed"
            ? "AI 处理失败"
            : outcome.outcome === "in_flight"
              ? "AI 处理中"
              : "AI 未回复",
      timeText: messageTime(
        outcome.startedAt ?? outcome.completedAt ?? new Date().toISOString(),
      ),
      occurredAt: outcome.startedAt ?? outcome.completedAt ?? "",
      anchorMessageId: anchor,
      lines,
      question: textExcerpt(trigger?.text, 60) || undefined,
      reply:
        outcome.outcome === "replied"
          ? textExcerpt(lastReply?.text, 80) || undefined
          : undefined,
      reasoning: live?.reasoning ?? null,
      turnId: outcome.turnId,
    });
  }
  // turn-outcomes 未覆盖进行中轮时（体检接口失败/滞后），live 气泡兜底成一个点
  if (
    props.liveThinking &&
    !outcomes.some((o) => o.turnId === props.liveThinking!.turnId)
  ) {
    rounds.push({
      key: `live-${props.liveThinking.turnId}`,
      kind: "agent",
      tone: "running",
      title: "AI 处理中",
      timeText: messageTime(
        props.liveThinking.startedAt ?? new Date().toISOString(),
      ),
      occurredAt: props.liveThinking.startedAt ?? "",
      anchorMessageId: null,
      lines: [
        `${props.liveThinking.lastEventLabel ?? "正在处理…"}${liveElapsedText.value ? ` · ${liveElapsedText.value}` : ""}`,
      ],
      reasoning: props.liveThinking.reasoning ?? null,
      turnId: props.liveThinking.turnId,
    });
  }

  // —— 人工回合：handoff cycle 被接受即成一回合 ——
  for (const cycle of props.handoff?.cycles ?? []) {
    if (!cycle.acceptedAt) continue; // 待认领/待接受的等待不算回合
    const resolvedAt: string | null = cycle.resolvedAt ?? null;
    const ongoing =
      !resolvedAt &&
      ["in_progress", "HUMAN_ACTIVE"].includes(String(cycle.status));
    const handler =
      mentionNameById.value.get(cycle.assignedUserId) ??
      (cycle.assignedUserId ? String(cycle.assignedUserId) : "客服");
    const lines = [`处理人 ${handler}`];
    lines.push(
      resolvedAt
        ? `${messageTime(cycle.acceptedAt)} – ${messageTime(resolvedAt)}`
        : `${messageTime(cycle.acceptedAt)} 起 · 处理中`,
    );
    if (cycle.reason) lines.push(`原因：${textExcerpt(String(cycle.reason), 60)}`);
    const acceptedTs = new Date(cycle.acceptedAt).getTime();
    const endTs = resolvedAt ? new Date(resolvedAt).getTime() : Infinity;
    const humanMessage = props.messages.find(
      (m) =>
        m.direction === "outbound" &&
        m.actorType !== "agent" &&
        m.actorType !== "system" &&
        acceptedTs - 2_000 <= new Date(m.occurredAt).getTime() &&
        new Date(m.occurredAt).getTime() <= endTs,
    );
    rounds.push({
      key: `human-${cycle.cycleId}`,
      kind: "human",
      tone: ongoing ? "running" : "info",
      title: ongoing ? "人工处理中" : "人工处理",
      timeText: messageTime(cycle.acceptedAt),
      occurredAt: cycle.acceptedAt,
      anchorMessageId:
        firstMessageAfter(cycle.acceptedAt)?.messageId ??
        props.messages[0]?.messageId ??
        null,
      lines,
      excerpt: textExcerpt(humanMessage?.text, 80) || undefined,
    });
  }

  // —— 唤醒跟进：已完成唤醒（空心点）——
  for (const wake of props.doneWakes) {
    rounds.push({
      key: `wake-${wake.wakeId}`,
      kind: "wake",
      tone: "info",
      title: wake.nudgeText ? "自动提醒" : "唤醒跟进",
      timeText: messageTime(wake.wakeAt),
      occurredAt: wake.wakeAt,
      anchorMessageId: firstMessageAfter(wake.wakeAt)?.messageId ?? null,
      lines: [wake.nudgeText ? "已自动发送提醒" : "已自动唤醒跟进"],
      turnId: wake.turnId,
    });
  }

  return rounds.sort(
    (a, b) =>
      new Date(a.occurredAt || 0).getTime() - new Date(b.occurredAt || 0).getTime(),
  );
});

// 侧轨点击：跳到对应回合并短暂高亮锚点消息
const railHighlightId = ref<string | null>(null);
let railHighlightTimer: ReturnType<typeof setTimeout> | undefined;
function onRailSelect(round: RailRound) {
  const pane = messagePane.value;
  if (!pane) return;
  const target = round.anchorMessageId
    ? document.getElementById(`message-${round.anchorMessageId}`)
    : null;
  if (target) {
    stopFollowingBottom();
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    railHighlightId.value = round.anchorMessageId;
    if (railHighlightTimer) clearTimeout(railHighlightTimer);
    railHighlightTimer = setTimeout(() => (railHighlightId.value = null), 2_000);
  } else {
    // 无锚点：进行中轮去底部（live 气泡在底部），其余回顶部
    pane.scrollTo({
      top: round.tone === "running" ? pane.scrollHeight : 0,
      behavior: "smooth",
    });
  }
}
watch(
  () => props.selected?.conversationId,
  () => {
    railHighlightId.value = null;
  },
);


const emit = defineEmits<{
  "open-customer": [];
  "open-settings": [];
  "open-transfer": [];
  "open-profile": [];
  takeover: [];
  accept: [];
  resolve: [];
  "reject-transfer": [];
  "reload-detail": [];
  "load-older": [];
  "jump-latest": [];
  "scroll": [];
  "update:replyText": [value: string];
  send: [];
  "pick-image": [event: Event];
  "pick-file": [event: Event];
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
const messageContent = ref<HTMLElement | null>(null);

/**
 * 底部跟随：图片等异步资源落地会持续撑高 scrollHeight，一次性滚动
 * （rAF + 150ms 校正）会被后续加载顶回原位，导致默认停在顶部。
 * 会话加载完成即进入跟随模式：内容每长高一截就贴到底部，直到用户
 * 主动上滚（滚轮/触摸）或本次加载带消息锚点（定位到指定消息）为止。
 */
let followBottom = false;
let followObserver: ResizeObserver | null = null;

function stopFollowingBottom() {
  followBottom = false;
}

watch(
  () => props.loadingConversation,
  (loading, wasLoading) => {
    if (wasLoading && !loading && !route.query.messageId) followBottom = true;
  },
);

onMounted(() => {
  followObserver = new ResizeObserver(() => {
    const pane = messagePane.value;
    if (!pane) return;
    if (followBottom) {
      pane.scrollTo({ top: pane.scrollHeight });
      return;
    }
    const distanceToBottom =
      pane.scrollHeight - pane.scrollTop - pane.clientHeight;
    if (distanceToBottom > 4 && distanceToBottom <= 72)
      pane.scrollTo({ top: pane.scrollHeight });
  });
});
// 滚动区在 v-if="selected" 之内，挂载时尚不存在——等 ref 出现再绑定观察
watch(messageContent, (el) => {
  if (!followObserver) return;
  followObserver.disconnect();
  if (el) followObserver.observe(el);
});
onBeforeUnmount(() => {
  followObserver?.disconnect();
  followObserver = null;
});

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
              @click="handoffStatus === 'pending' ? emit('accept') : emit('takeover')"
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

      <!-- 消息滚动区 + 回合侧轨：滚到顶自动加载更早（无限滚动） -->
      <div class="flex min-h-0 flex-1">
        <div
          ref="messagePane"
          class="min-w-0 flex-1 overflow-auto px-5 py-4"
          @scroll="onPaneScroll"
          @wheel.capture="stopFollowingBottom"
          @touchmove.capture="stopFollowingBottom"
        >
        <div ref="messageContent">
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
          <template v-for="message in messages" :key="message.messageId">
            <MessageBubble
              :message="message"
              :is-group="selectedIsGroup"
              :contact-id="selected?.contact?.contactId"
              :contact-fallback-name="selectedDisplay"
              :highlighted="route.query.messageId === message.messageId || railHighlightId === message.messageId"
              :messages="messages"
              :retry-busy="retryBusy"
              :outcome-busy="outcomeBusy"
              @contextmenu="(event, m) => emit('message-contextmenu', event, m)"
              @avatar-contextmenu="(event, m) => emit('avatar-contextmenu', event, m)"
              @retry="(m) => emit('retry-message', m)"
              @check-outcome="(m) => emit('check-outcome', m)"
            />
          </template>

          <!-- 「AI 正在思考」实时状态：单行瘦身胶囊，思维链收进侧轨进行中的点 -->
          <div v-if="liveThinking" class="my-2 flex">
            <div class="inline-flex items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
              <span class="inline-flex gap-0.5">
                <i class="size-1 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:0ms]" />
                <i class="size-1 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:150ms]" />
                <i class="size-1 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:300ms]" />
              </span>
              <span>
                {{ liveThinking.lastEventLabel }}<template v-if="liveElapsedText"> · {{ liveElapsedText }}</template>
              </span>
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
        </template>
        </div>
        </div>

        <!-- 回合侧轨：每点一回合，点击跳转+摘要卡片 -->
        <TurnRail
          v-if="railRounds.length"
          :rounds="railRounds"
          @select="onRailSelect"
          @open-trace="(turnId) => emit('open-trace', turnId)"
        />
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
        @pick-image="emit('pick-image', $event)"
        @pick-file="emit('pick-file', $event)"
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
