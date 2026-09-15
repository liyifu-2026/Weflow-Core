<script setup lang="ts">
/**
 * 会话工作台（组合层）：
 * 状态与机制在 composables/（列表 use-conversation-list / 选择与详情
 * use-conversation-selection / Inspector use-conversation-inspector /
 * 动作 use-conversation-actions / 滚动 use-transcript-scroll / 实时
 * use-conversation-realtime / 联系人 use-contact-list）与
 * lib/handoff-vocab.ts（Handoff 展示词汇表）；这里只做模块组装接线
 * 与模板编排。视觉子组件见 components/conversations/。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useWeflowAuthStore } from "../auth-store";
import AssetPicker, { type AssetPickResult } from "../components/AssetPicker.vue";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEscClose } from "../composables/use-esc-close";
import { useConversationList } from "../composables/use-conversation-list";
import { useConversationSelection } from "../composables/use-conversation-selection";
import { useConversationInspector } from "../composables/use-conversation-inspector";
import { useConversationActions } from "../composables/use-conversation-actions";
import { useConversationRealtime } from "../composables/use-conversation-realtime";
import { useTranscriptScroll } from "../composables/use-transcript-scroll";
import { useContactList } from "../composables/use-contact-list";
import { agentDisplayName, contactDisplayName, factLabel } from "../labels";
import { knowledgeTarget } from "../navigation-context";
import { useConversationWorkspaceStore } from "../stores/conversation-workspace";
import {
  canManualTakeoverFallback,
  canReplyFallback,
  canTransferFallback,
  canFinishFallback,
  composerDisabled,
  composerPlaceholder,
  ownershipLabel as ownershipLabelFor,
  transferPendingLabel as transferPendingLabelFor,
} from "../lib/handoff-vocab";
import ConversationList from "../components/conversations/ConversationList.vue";
import ChatPane from "../components/conversations/ChatPane.vue";
import InspectorPanel from "../components/conversations/InspectorPanel.vue";
import SessionTraceDrawer from "../components/conversations/SessionTraceDrawer.vue";

const auth = useWeflowAuthStore();
const route = useRoute();
const router = useRouter();
const workspaceStore = useConversationWorkspaceStore();
const workspace = workspaceStore.open(auth.user?.userId || "anonymous");

const search = computed({
  get: () => workspace.search,
  set: (value: string) => (workspace.search = value),
});
const replyText = computed({
  get: () => workspace.replyDraft,
  set: (value: string) => (workspace.replyDraft = value),
});

// ---------- 模块组装（依赖单向，UI 编排经回调衔接） ----------
const scroll = useTranscriptScroll({
  workspace,
  onReloadCurrent: () => selection.select(selection.selectedId.value),
});

const inspector = useConversationInspector({
  getSelectedId: () => selection.selectedId.value,
  getSelectedContactId: () => selection.selected.value?.contact?.contactId,
});

const list = useConversationList({
  search,
  getSelectedId: () => selection.selectedId.value,
  onAutoSelect: (id) => selection.select(id, false),
  getRouteId: () => (typeof route.query.id === "string" ? route.query.id : ""),
});

const settingsOpen = ref(false);
const selection = useConversationSelection({
  route,
  router,
  scroll,
  findSelected: (id) => list.findConversation(id),
  loadProfile: (id) => inspector.fetchProfile(id),
  applyProfile: (profile) => inspector.applyProfile(profile),
  onSelectionStart: () => {
    inspector.prepareForSelection();
    actions.dismissTransfer();
    settingsOpen.value = false;
  },
  onConversationSelected: (id) => realtime.startLivePolling(id),
  onSettled: () => void actions.autoCheckUnknownOutcomes(),
});

const realtime = useConversationRealtime({
  handlers: {
    getSelectedId: () => selection.selectedId.value,
    refreshFromServer: () => {
      void list.loadList();
      void selection.refreshTranscriptIncrementally();
    },
    onRealtimeFlush: (scope) => {
      void list.loadList();
      if (scope.transcript) void selection.refreshTranscriptIncrementally();
      if (scope.context) void selection.refreshContextSilently();
    },
  },
});

const actions = useConversationActions({
  selection,
  reloadList: () => list.loadList(),
  replyText,
  canReply: () => canReply.value,
  getMentionSources: () => mentionContacts.value,
  writeAssignees: (users) => (inspector.assignees.value = users),
});

const contactList = useContactList({ getQuery: () => search.value });

// ---------- 展示派生（词汇来自 lib/handoff-vocab） ----------
const {
  selectedId, selected, loadingConversation, detailError, messages, nextCursor,
  loadingOlder, handoff, agentSession, sessionWakes, turnHealth, evidence,
  sessionTraceLoading, sessionTrace, sessionTraceOpen, lastReplyTurnId,
  select, loadOlderMessages, openSessionTrace,
} = selection;
const {
  loadingList, listError, flatConversations, queueSections, hasMoreConversations,
  loadingMoreConversations, conversationPermissionsEnabled, loadList, loadOlderConversations,
} = list;
const {
  contacts, loading: contactsLoading, loadingMore: contactsLoadingMore,
  error: contactsError, nextCursor: contactsNextCursor, load: loadContacts,
} = contactList;
const { atBottom, newMessageCount, onMessagesScroll, jumpToLatest } = scroll;
const {
  inspectorOpen, inspectorView, inspectorTitle, inspectorDepth, company, profile, note, tags,
  assignees, historySelectedId, historyLoading, historyConversations, historyNextCursor,
  historyMessages, historyMessagesLoading, historyMessagesNextCursor,
  openInspector, closeInspector, inspectorBack, loadHistory, openHistoryConversation,
  loadMoreHistoryMessages,
} = inspector;
const {
  sending, retryBusy, actionBusy, mediaUploading, takeoverTransition, toolHint,
  transferOpen, transferTarget, transferTargetType, transferReason, transferQueues,
  outcomeBusy, replyTarget, transition, openTransfer, doTransfer, rejectIncomingTransfer,
  send, retryMessage, checkMessageOutcome, clearReplyTarget, onImagePicked, onFilePicked,
  submitAssetPick, setReplyTarget, sendPoke,
} = actions;
const { liveThinking } = realtime;

// ChatPane defineExpose 的滚动容器：消息锚定/跟随滚动都依赖它
const messagePaneHost = ref<InstanceType<typeof ChatPane> | null>(null);
watch(messagePaneHost, (host) => {
  scroll.pane.value = (host?.messagePane as HTMLElement | null) ?? null;
});

// 服务端 permissions（fail-safe：capability 开启后字段缺失 → 该操作只读）
const selectedPermissions = computed(() => selected.value?.permissions ?? null);
// AGENT_ACTIVE 才能 Manual Takeover；pending 走 Claim、transfer_pending 走 Accept（命令语义精确）
const canManualTakeover = computed(() =>
  conversationPermissionsEnabled.value
    ? (selectedPermissions.value?.canManualTakeover ?? false)
    : canManualTakeoverFallback(Boolean(handoff.value)),
);
const canTransfer = computed(() =>
  conversationPermissionsEnabled.value
    ? (selectedPermissions.value?.canTransfer ?? false)
    : canTransferFallback(mine.value),
);
const canFinish = computed(() =>
  conversationPermissionsEnabled.value
    ? (selectedPermissions.value?.canFinish ?? false)
    : canFinishFallback(mine.value),
);
const mine = computed(
  () =>
    handoff.value?.state?.status === "in_progress" &&
    handoff.value?.state?.assignedUserId === auth.user?.userId,
);
const canReply = computed(() =>
  conversationPermissionsEnabled.value
    ? Boolean(replyText.value.trim()) &&
      (selectedPermissions.value?.canReply ?? false)
    : canReplyFallback(replyText.value, handoff.value?.state, mine.value),
);
const selectedIsGroup = computed(() => selected.value?.chatType === "group");

const briefingLine = computed(
  () =>
    handoff.value?.briefing?.problemSummary ||
    (handoff.value ? "客户需要人工继续处理" : "Agent 正在自动处理"),
);
// Default brief stays short: ≤3 confirmed facts, ≤2 open items.
// Everything else lives in the "查看全部" brief drawer.
const confirmedFactsLine = computed(() => {
  const facts: Array<{ label: string; value: string }> =
    handoff.value?.briefing?.confirmedFacts ?? [];
  if (!facts.length) return "";
  const shown = facts
    .slice(0, 3)
    .map((fact) => factLabel(fact))
    .join(" · ");
  return facts.length > 3 ? `${shown} · …` : shown;
});
const unresolvedShort = computed(() => {
  const items: string[] = handoff.value?.briefing?.unresolvedItems ?? [];
  return items.slice(0, 2);
});

// 会话模式状态徽章：closed > handoff（既有）> waiting > active（第 3 期 session）
function sessionEpisodeLabel(): string | null {
  if (!agentSession.value) return null;
  if (agentSession.value.state === "closed") return "已收尾";
  if (handoff.value?.state?.status === "in_progress") return null; // 人工接管走既有徽章
  if (agentSession.value.state === "waiting") {
    return `等待客户 · 第 ${agentSession.value.roundsUsed} 轮`;
  }
  if (agentSession.value.state === "active") {
    return `AI 接待中 · 第 ${agentSession.value.roundsUsed} 轮`;
  }
  return null;
}
const pendingWake = computed(() => {
  const row = sessionWakes.value.find((w) => w.status === "scheduled");
  return row ?? null;
});
// 不截断：ChatPane 按 wakeAt 锚定到时间线内联展示，仅无锚定时在底部兜底
const doneWakes = computed(() =>
  sessionWakes.value.filter((w) => w.status === "done"),
);
const wakeCountdown = computed(() => {
  if (!pendingWake.value) return "";
  const remain = Math.max(
    0,
    new Date(pendingWake.value.wakeAt).getTime() - Date.now(),
  );
  const minutes = Math.floor(remain / 60_000);
  const seconds = Math.floor((remain % 60_000) / 1000);
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
});

function ownershipLabel() {
  return ownershipLabelFor(handoff.value?.state, mine.value);
}
const transferPendingLabel = computed(() =>
  transferPendingLabelFor(handoff.value?.state),
);
const composerPlaceholderText = computed(() =>
  composerPlaceholder(handoff.value?.state, mine.value),
);
const composerDisabledValue = computed(() =>
  composerDisabled(handoff.value?.state, mine.value),
);

const TRACE_EVENT_LABELS: Record<string, string> = {
  ownership_checked: "领取轮次",
  triaged: "分流",
  policy_decided: "决策",
  reply_persisted: "回复落库",
  context_built: "上下文装配",
  tool_planned: "工具规划",
  tool_checkpoint_persisted: "工具检查点",
  tool_completed: "工具完成",
  tool_execution_reclaimed: "工具租约回收",
  execution_resumed: "恢复续跑",
  knowledge_retrieved: "知识检索",
  model_call: "模型调用",
  model_reasoning: "思维链",
  validation_passed: "校验通过",
  validation_failed: "校验失败",
  suppressed: "策略抑制",
  handoff_created: "转人工",
  turn_error: "执行出错",
  turn_failed: "轮次失败",
  scheduled_send_created: "定时发送已排",
  scheduled_send_cancelled: "定时发送取消",
  delivery_confirmed: "投递确认",
  delivery_failed: "投递失败",
  delivery_unknown: "投递未知",
  reply_step_persisted: "续步回复落库",
  tool_note_persisted: "过程短讯落库",
  reply_held: "回复被扣留",
};

// ---------- 搜索合一（UX-DECISIONS §1）：单一搜索框，空态为队列 ----------
// 输入防抖 300ms，同时搜会话（loadList 搜索分支）与联系人。
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(search, (value) => {
  clearTimeout(searchTimer);
  const q = value.trim();
  if (!q) {
    contactList.clear();
    void loadList();
    return;
  }
  searchTimer = setTimeout(() => {
    void loadList();
    void loadContacts();
  }, 300);
});

// 联系人搜索结果点击：清搜索回队列视图并选中对应会话
function selectContactAndSwitch(conversationId: string) {
  workspace.search = "";
  void select(conversationId);
}

watch(
  () => route.query.id,
  (id) => {
    if (typeof id === "string" && id !== selectedId.value)
      void select(id, false);
  },
);

// ---------- 会话设置 / 素材选择器 / 右键菜单（纯 UI 状态） ----------
async function saveProfile() {
  try {
    await inspector.saveProfile();
    settingsOpen.value = false;
  } catch (reason) {
    detailError.value =
      reason instanceof Error ? reason.message : "资料保存失败";
  }
}
const assetPickerOpen = ref(false);
const canManageAssets = computed(() => auth.isAdmin);
async function onAssetPicked(result: AssetPickResult) {
  assetPickerOpen.value = false;
  await submitAssetPick(result);
}

// --- 消息右键菜单（按目标拆分）：气泡=回复，头像=拍一拍 ---
const messageMenu = ref<{
  x: number;
  y: number;
  message: (typeof messages.value)[number];
  kind: "bubble" | "avatar";
} | null>(null);
function openMessageMenu(
  event: MouseEvent,
  message: (typeof messages.value)[number],
  kind: "bubble" | "avatar" = "bubble",
) {
  event.preventDefault();
  messageMenu.value = { x: event.clientX, y: event.clientY, message, kind };
}
function closeMessageMenu() {
  messageMenu.value = null;
}
function handleMenuReply(message: (typeof messages.value)[number]) {
  setReplyTarget(message);
  closeMessageMenu();
}
function handleMenuPoke(message: (typeof messages.value)[number]) {
  sendPoke(message);
  closeMessageMenu();
}

// --- @提及候选（联系人 + 客服） ---
const mentionContacts = computed(() => {
  const sources: Array<{ id: string; name: string }> = [];
  // 从联系人 profile
  if (inspector.profile.value?.contactId) {
    sources.push({ id: inspector.profile.value.contactId, name: contactDisplayName(selected.value) || "联系人" });
  }
  // 从 assignees（客服列表）
  for (const u of assignees.value) {
    sources.push({ id: u.userId, name: u.displayName || u.username || u.userId });
  }
  return sources;
});

// ⌘/Ctrl + Shift + H：eligible 时主动接管当前 Agent 会话（快捷入口，非主要发现路径）
const anyOverlayOpen = computed(
  () =>
    inspectorOpen.value || transferOpen.value || settingsOpen.value,
);
function onTakeoverShortcut(event: KeyboardEvent) {
  if (
    !(event.metaKey || event.ctrlKey) ||
    !event.shiftKey ||
    event.key.toLowerCase() !== "h"
  )
    return;
  if (
    anyOverlayOpen.value ||
    !canManualTakeover.value ||
    !selectedId.value ||
    actionBusy.value
  )
    return;
  event.preventDefault();
  void transition("take-over");
}
useEscClose(anyOverlayOpen, () => {
  inspectorOpen.value = false;
  transferOpen.value = false;
  settingsOpen.value = false;
});

onMounted(async () => {
  await Promise.all([
    loadList(true),
    inspector.loadAssignees().catch(() => undefined),
    list.loadCapabilities(),
  ]);
  realtime.connect();
  window.addEventListener("keydown", onTakeoverShortcut);
});
onUnmounted(() => {
  scroll.rememberScroll();
  window.removeEventListener("keydown", onTakeoverShortcut);
});

// 证据/知识检索跳转（当前会话最近一条上下文随行）
function openEvidence(item: (typeof evidence.value)[number]) {
  if (!selectedId.value) return;
  const latestAgent = [...messages.value]
    .reverse()
    .find((message) => message.actorType === "agent");
  void router.push(
    knowledgeTarget(
      {
        type: "conversation",
        conversationId: selectedId.value,
        messageId: latestAgent?.messageId,
        evidenceId: item.evidenceId,
      },
      {
        knowledgeBaseId: item.knowledgeBaseId,
        documentId: item.documentId,
        chunkId: item.chunkId,
        evidenceId: item.evidenceId,
      },
    ),
  );
}
function searchKnowledge() {
  if (!selectedId.value) return;
  const latestQuestion = [...messages.value]
    .reverse()
    .find((message) => message.direction === "inbound")?.text;
  void router.push(
    knowledgeTarget(
      { type: "conversation", conversationId: selectedId.value },
      { question: latestQuestion },
    ),
  );
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="grid min-h-0 flex-1 grid-cols-[clamp(220px,18vw,280px)_minmax(0,1fr)_auto] overflow-hidden max-[860px]:grid-cols-[clamp(200px,30vw,260px)_minmax(0,1fr)]">
      <ConversationList
        v-model:search="search"
        :selected-id="selectedId"
        :conversation-permissions-enabled="conversationPermissionsEnabled"
        :flat-conversations="flatConversations"
        :queue-sections="queueSections"
        :has-more-conversations="hasMoreConversations"
        :loading-more-conversations="loadingMoreConversations"
        :loading-list="loadingList"
        :list-error="listError"
        :contacts="contacts"
        :contacts-loading="contactsLoading"
        :contacts-loading-more="contactsLoadingMore"
        :contacts-error="contactsError"
        :contacts-next-cursor="contactsNextCursor"
        @select="(id) => select(id)"
        @select-contact="selectContactAndSwitch"
        @reload="() => loadList()"
        @load-more="loadOlderConversations"
        @load-contacts="(append: boolean) => loadContacts(append)"
      />

      <ChatPane
        ref="messagePaneHost"
        :selected="selected ?? null"
        :selected-is-group="selectedIsGroup"
        :company="company"
        :loading-conversation="loadingConversation"
        :detail-error="detailError"
        :messages="messages"
        :session-badge-label="sessionEpisodeLabel()"
        :live-thinking="liveThinking"
        :pending-wake="pendingWake"
        :agent-session-waiting="agentSession?.state === 'waiting'"
        :wake-countdown="wakeCountdown"
        :done-wakes="doneWakes"
        :at-bottom="atBottom"
        :new-message-count="newMessageCount"
        :next-cursor="nextCursor"
        :loading-older="loadingOlder"
        :loading-more-flag="loadingMoreConversations"
        :can-manual-takeover="canManualTakeover"
        :takeover-transition="takeoverTransition"
        :action-busy="actionBusy"
        :briefing-line="briefingLine"
        :can-transfer="canTransfer"
        :can-finish="canFinish"
        :handoff-status="handoff?.state?.status"
        :transfer-pending-label="transferPendingLabel"
        :can-reject-transfer="Boolean(handoff?.state?.canRejectTransfer)"
        v-model:reply-text="replyText"
        :sending="sending"
        :can-reply="Boolean(canReply)"
        :is-mine="mine"
        :media-uploading="mediaUploading"
        :tool-hint="toolHint"
        :reply-target="replyTarget"
        :mention-contacts="mentionContacts"
        :composer-placeholder="composerPlaceholderText"
        :composer-disabled="composerDisabledValue"
        :retry-busy="retryBusy"
        :outcome-busy="outcomeBusy"
        @open-customer="openInspector('customer')"
        @open-settings="settingsOpen = true"
        @open-transfer="openTransfer()"
        @open-profile="router.push('/profile')"
        @takeover="transition('take-over')"
        @accept="transition('accept')"
        @resolve="transition('resolve')"
        @reject-transfer="rejectIncomingTransfer"
        @reload-detail="select(selectedId)"
        @load-older="loadOlderMessages"
        @jump-latest="jumpToLatest"
        @scroll="onMessagesScroll"
        @send="send"
        @pick-image="onImagePicked"
        @pick-file="onFilePicked"
        @open-assets="assetPickerOpen = true"
        @clear-reply="clearReplyTarget"
        @message-contextmenu="(event, m) => openMessageMenu(event, m, 'bubble')"
        @avatar-contextmenu="(event, m) => openMessageMenu(event, m, 'avatar')"
        @retry-message="retryMessage"
        @check-outcome="checkMessageOutcome"
        @open-trace="openSessionTrace"
        :turn-health="turnHealth"
        :handoff="handoff ?? null"
      />

      <InspectorPanel
        :open="inspectorOpen"
        :view="inspectorView"
        :title="inspectorTitle"
        :depth="inspectorDepth"
        :selected="selected ?? null"
        :company="company"
        :handoff="handoff"
        :evidence="evidence"
        :ownership-label="ownershipLabel()"
        :briefing-line="briefingLine"
        :confirmed-facts-line="confirmedFactsLine"
        :unresolved-short="unresolvedShort"
        :agent-session="agentSession"
        :session-badge-label="sessionEpisodeLabel()"
        :pending-wake="pendingWake"
        :done-wakes="doneWakes"
        :wake-countdown="wakeCountdown"
        :last-reply-turn-id="lastReplyTurnId"
        :turn-health="turnHealth"
        :risk="selected?.riskLevel ?? null"
        v-model:note="note"
        v-model:tags="tags"
        :history-selected-id="historySelectedId"
        :history-loading="historyLoading"
        :history-conversations="historyConversations"
        :history-next-cursor="historyNextCursor"
        :history-messages="historyMessages"
        :history-messages-loading="historyMessagesLoading"
        :history-messages-next-cursor="historyMessagesNextCursor"
        @close="closeInspector"
        @back="inspectorBack"
        @open-view="openInspector"
        @open-evidence="openEvidence"
        @search-knowledge="searchKnowledge"
        @open-trace="openSessionTrace"
        @save-profile="saveProfile"
        @open-history-conversation="openHistoryConversation"
        @load-history-more="loadHistory(true)"
        @load-history-messages-more="loadMoreHistoryMessages()"
      />
    </div>

    <!-- 转交处理 -->
    <Dialog :open="transferOpen" @update:open="(value) => (transferOpen = value)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>转交处理</DialogTitle>
        </DialogHeader>
        <div class="space-y-4">
          <div class="space-y-2">
            <Label for="transfer-reason">转交原因</Label>
            <Input
              id="transfer-reason"
              v-model="transferReason"
              placeholder="例如：需要设备团队处理"
            />
          </div>
          <div class="inline-flex rounded-md border border-border bg-muted p-0.5">
            <button
              class="rounded-[5px] px-3 py-1.5 text-sm transition-colors"
              :class="transferTargetType === 'user' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
              @click="transferTargetType = 'user'; transferTarget = ''"
            >
              转给客服
            </button>
            <button
              v-if="transferQueues.length"
              class="rounded-[5px] px-3 py-1.5 text-sm transition-colors"
              :class="transferTargetType === 'queue' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
              @click="transferTargetType = 'queue'; transferTarget = ''"
            >
              专业队列
            </button>
          </div>
          <p v-if="transferTargetType === 'queue'" class="text-xs text-muted-foreground">
            当前负责人释放，会话进入队列等待成员接手。
          </p>
          <p v-else class="text-xs text-muted-foreground">
            等待目标客服接受；拒绝或超时后按服务端规则处理。
          </p>
          <div class="max-h-52 space-y-1 overflow-y-auto">
            <template v-if="transferTargetType === 'user'">
              <button
                v-for="user in assignees"
                :key="user.userId"
                class="flex w-full items-center rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60"
                :class="{ 'bg-muted': transferTarget === user.userId }"
                @click="transferTarget = user.userId"
              >
                {{ agentDisplayName(user) }}
              </button>
              <p v-if="!assignees.length" class="py-2 text-sm text-muted-foreground">暂无可转交的客服。</p>
            </template>
            <template v-else>
              <button
                v-for="queue in transferQueues"
                :key="queue.queueId"
                class="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60"
                :class="{ 'bg-muted': transferTarget === queue.queueId }"
                @click="transferTarget = queue.queueId"
              >
                {{ queue.displayName }}
                <span class="text-xs text-muted-foreground">等待队列成员接手</span>
              </button>
              <p v-if="!transferQueues.length" class="py-2 text-sm text-muted-foreground">
                当前没有可接收转交的队列。
              </p>
            </template>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="transferOpen = false">取消</Button>
          <Button
            :disabled="!transferTarget || !transferReason.trim() || actionBusy"
            @click="doTransfer"
          >
            {{ actionBusy ? "转交中" : "确认转交" }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 会话设置 -->
    <Dialog
      :open="settingsOpen && Boolean(profile)"
      @update:open="(value) => (settingsOpen = value)"
    >
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>会话设置</DialogTitle>
        </DialogHeader>
        <div class="space-y-3">
          <label class="flex items-center gap-2 text-sm">
            <Checkbox
              v-model="profile.agentEnabled"
              :disabled="handoff?.state?.status === 'in_progress' && !mine"
            />
            允许 Agent 自动回复
          </label>
          <p class="text-xs text-muted-foreground">
            关闭后，该客户的后续消息不会由 Agent 自动回复。
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="settingsOpen = false">取消</Button>
          <Button @click="saveProfile">保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 消息右键菜单 -->
    <Teleport to="body">
      <div
        v-if="messageMenu"
        class="fixed z-[9999] min-w-28 rounded-md border border-border bg-popover p-1 shadow-md"
        :style="{ left: messageMenu.x + 'px', top: messageMenu.y + 'px' }"
      >
        <button
          v-if="messageMenu.kind === 'bubble'"
          class="block w-full rounded-sm px-3 py-1.5 text-left text-sm transition-colors hover:bg-muted"
          @click="handleMenuReply(messageMenu.message)"
        >
          回复
        </button>
        <button
          v-if="messageMenu.kind === 'avatar'"
          class="block w-full rounded-sm px-3 py-1.5 text-left text-sm transition-colors hover:bg-muted"
          @click="handleMenuPoke(messageMenu.message)"
        >
          拍一拍
        </button>
      </div>
    </Teleport>
    <div
      v-if="messageMenu"
      class="fixed inset-0 z-[9998]"
      @click="closeMessageMenu"
      @contextmenu.prevent="closeMessageMenu"
    ></div>

    <!-- 决策轨迹抽屉 -->
    <SessionTraceDrawer
      :open="sessionTraceOpen"
      :loading="sessionTraceLoading"
      :trace="sessionTrace"
      :event-labels="TRACE_EVENT_LABELS"
      @close="sessionTraceOpen = false"
    />

    <!-- 素材选择器（本机文件 / 图片空间 / 文件空间） -->
    <Teleport to="body">
      <AssetPicker
        v-if="assetPickerOpen"
        :can-manage="canManageAssets"
        @close="assetPickerOpen = false"
        @pick="onAssetPicked"
      />
    </Teleport>
  </div>
</template>
