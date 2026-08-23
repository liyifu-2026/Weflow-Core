<script setup lang="ts">
/**
 * Customer Support 客服工作台
 *
 * This is a business Solution console extension. It is embedded into the
 * Weflow Console through `consoleExtensions` and talks to Core platform APIs
 * directly. All business-specific copy lives here, not in the platform.
 */
import { computed, onMounted, ref } from "vue";
import { api } from "../api";
import MediaImage from "../components/MediaImage.vue";
import SupportIcon from "../components/SupportIcon.vue";
import { supportConfirm } from "../components/confirm";
import {
  acceptHandoff,
  createMemory,
  finishHandoff,
  getContactProfile,
  getEvidenceTray,
  getHandoffDetail,
  getTranscript,
  listConversations,
  listHandoffAssignees,
  listHandoffQueues,
  listMemories,
  rejectTransfer,
  releaseHandoff,
  resolveHandoff,
  sendManualReply,
  takeOverHandoff,
  transferHandoff,
  transitionMemory,
  type ConversationEvidence,
  type ContactProfile,
  type ConversationListItem,
  type ConversationScope,
  type HandoffAssignee,
  type HandoffBriefing,
  type HandoffDetail,
  type HandoffQueue,
  type Memory,
  type TranscriptMessage,
} from "../conversations/api";
import {
  handoffResultOptions,
  handoffStatusLabel,
  memoryKindLabel,
  memoryStatusLabel,
  memoryTone,
} from "../conversations/labels";

type Me = { userId: string; username: string; role: string };

const me = ref<Me | null>(null);
const scopes: Array<{ key: ConversationScope; label: string }> = [
  { key: "attention", label: "待处理" },
  { key: "mine", label: "我的" },
  { key: "others", label: "其他" },
  { key: "all", label: "全部" },
];
const scope = ref<ConversationScope>("attention");
const conversations = ref<ConversationListItem[]>([]);
const nextCursor = ref<string | null>(null);
const listLoading = ref(false);
const listLoadingMore = ref(false);
const listError = ref("");
const selectedId = ref<string | null>(null);
const selected = ref<ConversationListItem | null>(null);

const transcript = ref<TranscriptMessage[]>([]);
const transcriptNextCursor = ref<string | null>(null);
const conversationRevision = ref(0);
const transcriptLoading = ref(false);
const transcriptLoadingMore = ref(false);
const transcriptError = ref("");
const detail = ref<HandoffDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const profile = ref<ContactProfile | null>(null);
const memories = ref<Memory[]>([]);
const evidence = ref<ConversationEvidence[]>([]);
const contextLoading = ref(false);
const contextError = ref("");

const composerText = ref("");
const sending = ref(false);
const actionBusy = ref(false);
const notice = ref("");
const noticeKind = ref<"ok" | "err">("ok");

const transferOpen = ref(false);
const transferTargetType = ref<"user" | "queue">("user");
const transferTargetId = ref("");
const transferReason = ref("");
const transferBusy = ref(false);
const transferError = ref("");
const transferUsers = ref<HandoffAssignee[]>([]);
const transferQueues = ref<HandoffQueue[]>([]);

const finishOpen = ref(false);
const finishResult = ref("resolved_by_human");
const finishBusy = ref(false);
const finishError = ref("");

const memoryFormOpen = ref(false);
const memoryKind = ref<Memory["kind"]>("fact");
const memoryKey = ref("");
const memoryContent = ref("");
const memoryImportance = ref(3);
const memoryBusy = ref(false);
const memoryError = ref("");

const handoffState = computed(() => detail.value?.state ?? null);
const isMine = computed(
  () =>
    handoffState.value?.status === "HUMAN_ACTIVE" &&
    handoffState.value.assignedUserId === me.value?.userId,
);
const legacyMine = computed(
  () =>
    selected.value?.handoff?.status === "in_progress" &&
    selected.value.handoff.assignedUserId === me.value?.userId &&
    selected.value.permissions.canFinish === true,
);
const canActOnCurrent = computed(() => isMine.value || legacyMine.value);
const hasMobileHandoff = computed(() => handoffState.value !== null);
const canReply = computed(
  () => selected.value?.permissions.canReply === true || isMine.value === true,
);

function flash(message: string, kind: "ok" | "err" = "ok") {
  notice.value = message;
  noticeKind.value = kind;
}

function newClientRequestId(): string {
  return crypto.randomUUID();
}

function contactName(item: ConversationListItem | null | undefined): string {
  if (!item) return "—";
  return (
    item.contact.sharedAlias ||
    item.contact.channelDisplayName ||
    item.contact.channelNickname ||
    item.contact.channelRemark ||
    item.contact.channelContactId ||
    "未知联系人"
  );
}

async function loadMe() {
  try {
    const data = await api<{ user: Me }>("/api/v1/auth/me");
    me.value = data.user;
  } catch {
    me.value = null;
  }
}

async function loadConversations(reset = true) {
  if (listLoading.value || listLoadingMore.value) return;
  if (reset) {
    listLoading.value = true;
    conversations.value = [];
    nextCursor.value = null;
  } else {
    listLoadingMore.value = true;
  }
  listError.value = "";
  try {
    const data = await listConversations({
      scope: scope.value,
      limit: 50,
      before: reset ? undefined : (nextCursor.value ?? undefined),
    });
    if (reset) conversations.value = data.conversations;
    else conversations.value = [...conversations.value, ...data.conversations];
    nextCursor.value = data.nextCursor ?? null;
    if (selectedId.value) {
      selected.value =
        conversations.value.find(
          (item) => item.conversationId === selectedId.value,
        ) ?? selected.value;
    }
  } catch (reason) {
    listError.value = reason instanceof Error ? reason.message : "会话列表加载失败";
  } finally {
    listLoading.value = false;
    listLoadingMore.value = false;
  }
}

function changeScope(next: ConversationScope) {
  if (scope.value === next) return;
  scope.value = next;
  void loadConversations(true);
}

async function loadTranscript(id: string, before?: string, appendOlder = false) {
  if (transcriptLoading.value || transcriptLoadingMore.value) return;
  if (appendOlder) transcriptLoadingMore.value = true;
  else transcriptLoading.value = true;
  transcriptError.value = "";
  try {
    const data = await getTranscript(id, {
      limit: 50,
      before: before ?? undefined,
    });
    conversationRevision.value = data.conversationRevision;
    transcriptNextCursor.value = data.nextCursor;
    transcript.value = appendOlder
      ? [...data.messages, ...transcript.value]
      : data.messages;
    if (!appendOlder) {
      const lastInbound = [...transcript.value]
        .reverse()
        .find((message) => message.direction === "inbound");
      if (lastInbound) {
        void api(`/api/v1/conversations/${encodeURIComponent(id)}/read`, {
          method: "POST",
          body: JSON.stringify({ lastReadMessageId: lastInbound.messageId }),
        }).catch(() => undefined);
      }
    }
  } catch (reason) {
    transcriptError.value =
      reason instanceof Error ? reason.message : "消息记录加载失败";
  } finally {
    transcriptLoading.value = false;
    transcriptLoadingMore.value = false;
  }
}

async function loadHandoff(id: string) {
  detailLoading.value = true;
  detailError.value = "";
  detail.value = null;
  try {
    const data = await getHandoffDetail(id);
    const handoff = data.handoff;
    if (
      handoff &&
      typeof handoff === "object" &&
      "state" in handoff &&
      handoff.state &&
      typeof handoff.state === "object"
    ) {
      const state = handoff.state as Record<string, unknown>;
      const mobileStatus =
        typeof state.status === "string" &&
        [
          "HANDOFF_PENDING",
          "TRANSFER_PENDING",
          "HUMAN_ACTIVE",
          "HUMAN_FINISHED",
        ].includes(state.status);
      if (mobileStatus || "canClaim" in state) {
        detail.value = handoff as HandoffDetail;
      } else {
        detail.value = null;
      }
    } else {
      detail.value = null;
    }
  } catch (reason) {
    if (
      reason instanceof Error &&
      (reason as { code?: string }).code === "handoff_not_found"
    ) {
      detail.value = null;
    } else {
      detailError.value =
        reason instanceof Error ? reason.message : "Handoff 状态加载失败";
    }
  } finally {
    detailLoading.value = false;
  }
}

async function loadContext(id: string) {
  contextLoading.value = true;
  contextError.value = "";
  profile.value = null;
  memories.value = [];
  evidence.value = [];
  try {
    const [profileData, memoryData, evidenceData] = await Promise.all([
      getContactProfile(id).catch(() => ({ profile: null })),
      listMemories(id, "all").catch(() => ({ memories: [] })),
      getEvidenceTray(id).catch(() => ({ conversationId: id, evidence: [] })),
    ]);
    profile.value = profileData.profile;
    memories.value = memoryData.memories;
    evidence.value = evidenceData.evidence;
  } catch (reason) {
    contextError.value =
      reason instanceof Error ? reason.message : "上下文加载失败";
  } finally {
    contextLoading.value = false;
  }
}

async function selectConversation(item: ConversationListItem) {
  selectedId.value = item.conversationId;
  selected.value = item;
  transcript.value = [];
  transcriptNextCursor.value = null;
  conversationRevision.value = 0;
  await Promise.all([
    loadTranscript(item.conversationId),
    loadHandoff(item.conversationId),
    loadContext(item.conversationId),
  ]);
}

async function loadOlder() {
  if (!selectedId.value || !transcriptNextCursor.value) return;
  await loadTranscript(selectedId.value, transcriptNextCursor.value, true);
}

async function sendReply() {
  const text = composerText.value.trim();
  if (!text || !selectedId.value || sending.value) return;
  sending.value = true;
  try {
    await sendManualReply(selectedId.value, {
      text,
      clientRequestId: newClientRequestId(),
      expectedConversationRevision: conversationRevision.value,
    });
    composerText.value = "";
    await loadTranscript(selectedId.value);
  } catch (reason) {
    flash(reason instanceof Error ? reason.message : "回复发送失败", "err");
  } finally {
    sending.value = false;
  }
}

async function refreshAfterHandoff() {
  if (selectedId.value) {
    await Promise.all([
      loadHandoff(selectedId.value),
      loadTranscript(selectedId.value),
    ]);
  }
  await loadConversations(true);
}

async function doTakeOver() {
  if (!selectedId.value || actionBusy.value) return;
  if (!(await supportConfirm("确认接管该会话？接管后 Agent 将暂停处理该会话。"))) return;
  actionBusy.value = true;
  try {
    await takeOverHandoff(selectedId.value, {
      clientRequestId: newClientRequestId(),
      sourceConversationRevision: conversationRevision.value,
    });
    flash("已接管会话");
    await refreshAfterHandoff();
  } catch (reason) {
    flash(reason instanceof Error ? reason.message : "接管失败", "err");
  } finally {
    actionBusy.value = false;
  }
}

async function doClaim() {
  if (!selectedId.value || actionBusy.value) return;
  actionBusy.value = true;
  try {
    await acceptHandoff(
      selectedId.value,
      handoffState.value
        ? {
            clientRequestId: newClientRequestId(),
            expectedHandoffRevision: handoffState.value.handoffRevision,
          }
        : {
            clientRequestId: newClientRequestId(),
            summary: "接手处理",
          },
    );
    flash("已接手处理");
    await refreshAfterHandoff();
  } catch (reason) {
    flash(reason instanceof Error ? reason.message : "接手失败", "err");
  } finally {
    actionBusy.value = false;
  }
}

async function doRejectTransfer() {
  if (!selectedId.value || !handoffState.value || actionBusy.value) return;
  if (!(await supportConfirm("拒绝这次转交？会话会回到可认领队列。"))) return;
  actionBusy.value = true;
  try {
    await rejectTransfer(selectedId.value, {
      expectedHandoffRevision: handoffState.value.handoffRevision,
      clientRequestId: newClientRequestId(),
    });
    flash("已拒绝转交");
    await refreshAfterHandoff();
  } catch (reason) {
    flash(reason instanceof Error ? reason.message : "拒绝转交失败", "err");
  } finally {
    actionBusy.value = false;
  }
}

async function doRelease() {
  if (!selectedId.value || actionBusy.value) return;
  if (!(await supportConfirm("释放该会话到待认领队列？"))) return;
  actionBusy.value = true;
  try {
    await releaseHandoff(selectedId.value, {
      summary: "操作员释放回队列",
      clientRequestId: newClientRequestId(),
    });
    flash("已释放回队列");
    await refreshAfterHandoff();
  } catch (reason) {
    flash(reason instanceof Error ? reason.message : "释放失败", "err");
  } finally {
    actionBusy.value = false;
  }
}

function openFinish() {
  finishResult.value = "resolved_by_human";
  finishError.value = "";
  finishOpen.value = true;
}

async function submitFinish() {
  if (!selectedId.value || finishBusy.value) return;
  finishBusy.value = true;
  finishError.value = "";
  try {
    if (handoffState.value) {
      await finishHandoff(selectedId.value, {
        expectedHandoffRevision: handoffState.value.handoffRevision,
        clientRequestId: newClientRequestId(),
        result: finishResult.value,
      });
    } else {
      await resolveHandoff(selectedId.value, {
        summary: "人工处理完成",
        clientRequestId: newClientRequestId(),
      });
    }
    finishOpen.value = false;
    flash("已结束人工处理");
    await refreshAfterHandoff();
  } catch (reason) {
    finishError.value =
      reason instanceof Error ? reason.message : "结束失败，请重试";
  } finally {
    finishBusy.value = false;
  }
}

async function openTransfer() {
  transferTargetType.value = "user";
  transferTargetId.value = "";
  transferReason.value = "";
  transferError.value = "";
  transferUsers.value = [];
  transferQueues.value = [];
  transferOpen.value = true;
  try {
    const [users, queues] = await Promise.all([
      listHandoffAssignees(),
      listHandoffQueues(),
    ]);
    transferUsers.value = users.users;
    transferQueues.value = queues.queues;
  } catch (reason) {
    transferError.value =
      reason instanceof Error ? reason.message : "转交目标加载失败";
  }
}

async function submitTransfer() {
  if (!selectedId.value || transferBusy.value) return;
  if (!transferTargetId.value) {
    transferError.value = "请选择转交目标";
    return;
  }
  transferBusy.value = true;
  transferError.value = "";
  try {
    if (handoffState.value) {
      await transferHandoff(selectedId.value, {
        targetType: transferTargetType.value,
        targetId: transferTargetId.value,
        transferReason: transferReason.value || undefined,
        sourceConversationRevision: conversationRevision.value,
        expectedHandoffRevision: handoffState.value.handoffRevision,
        clientRequestId: newClientRequestId(),
      });
    } else {
      if (transferTargetType.value !== "user") {
        transferError.value = "当前会话仅支持转交操作员";
        return;
      }
      await transferHandoff(selectedId.value, {
        targetUserId: transferTargetId.value,
        summary: transferReason.value || "转交",
        clientRequestId: newClientRequestId(),
      });
    }
    transferOpen.value = false;
    flash("已发起转交");
    await refreshAfterHandoff();
  } catch (reason) {
    transferError.value =
      reason instanceof Error ? reason.message : "转交失败，请重试";
  } finally {
    transferBusy.value = false;
  }
}

function openMemoryForm() {
  memoryKind.value = "fact";
  memoryKey.value = "";
  memoryContent.value = "";
  memoryImportance.value = 3;
  memoryError.value = "";
  memoryFormOpen.value = true;
}

async function submitMemory() {
  if (!selectedId.value || memoryBusy.value) return;
  const key = memoryKey.value.trim().toLowerCase();
  const content = memoryContent.value.trim();
  if (!/^[a-z0-9_.-]{1,100}$/.test(key)) {
    memoryError.value = "记忆键只能包含小写字母、数字、_ . -，长度 1–100";
    return;
  }
  if (!content) {
    memoryError.value = "请填写记忆内容";
    return;
  }
  memoryBusy.value = true;
  memoryError.value = "";
  try {
    await createMemory(selectedId.value, {
      kind: memoryKind.value,
      key,
      content,
      importance: memoryImportance.value,
      clientRequestId: newClientRequestId(),
    });
    memoryFormOpen.value = false;
    flash("已添加记忆");
    await loadContext(selectedId.value);
  } catch (reason) {
    memoryError.value =
      reason instanceof Error ? reason.message : "记忆保存失败";
  } finally {
    memoryBusy.value = false;
  }
}

async function doMemoryAction(memory: Memory, action: "activate" | "invalidate") {
  if (!selectedId.value) return;
  try {
    await transitionMemory(
      selectedId.value,
      memory.memoryId,
      action,
      newClientRequestId(),
    );
    await loadContext(selectedId.value);
  } catch (reason) {
    flash(reason instanceof Error ? reason.message : "记忆状态更新失败", "err");
  }
}

function messageBubbleClass(message: TranscriptMessage): Record<string, boolean> {
  const inbound = message.direction === "inbound";
  const failed =
    message.sendState === "failed" ||
    message.sendState === "unknown" ||
    message.processingState === "failed";
  return {
    me: !inbound,
    agent: !inbound && message.actorType === "agent",
    system: !inbound && message.actorType === "system",
    failed: Boolean(failed),
    unknown: message.sendState === "unknown",
  };
}

function messageTime(value: string): string {
  return new Date(value).toLocaleString();
}

function briefingText(briefing: HandoffBriefing | null | undefined): string {
  if (!briefing) return "";
  const reason = "handoffReason" in briefing ? briefing.handoffReason : "";
  return briefing.problemSummary || reason || "";
}

function factLabel(fact: { key: string; label: string; value: string }): string {
  return `${fact.label || fact.key} ${fact.value}`.trim();
}

onMounted(() => {
  void loadMe();
  void loadConversations(true);
});
</script>

<template>
  <div class="support-page">
    <div v-if="notice" class="wf-notice" :class="{ 'wf-error': noticeKind === 'err' }">
      {{ notice }}
      <button class="wf-icon-button" @click="notice = ''"><SupportIcon name="close" /></button>
    </div>

    <div class="support-layout">
      <aside class="support-list">
        <div class="support-toolbar">
          <div class="support-tabs">
            <button
              v-for="item in scopes"
              :key="item.key"
              class="support-tab"
              :class="{ active: scope === item.key }"
              @click="changeScope(item.key)"
            >
              {{ item.label }}
            </button>
          </div>
        </div>

        <div v-if="listError" class="wf-error">
          <span>{{ listError }}</span>
          <button class="wf-button compact" @click="loadConversations(true)">重试</button>
        </div>

        <div v-if="listLoading" class="support-rows">
          <div v-for="i in 6" :key="i" class="support-row skeleton"></div>
        </div>

        <div v-else class="support-rows">
          <button
            v-for="item in conversations"
            :key="item.conversationId"
            class="support-row"
            :class="{ active: selectedId === item.conversationId }"
            @click="selectConversation(item)"
          >
            <span class="row-title">
              <strong>{{ contactName(item) }}</strong>
              <span v-if="item.handoff" class="wf-status" :class="item.handoff.status === 'in_progress' ? 'accent' : item.handoff.status === 'pending' || item.handoff.status === 'transfer_pending' ? 'warn' : 'good'">
                {{ handoffStatusLabel(item.handoff.status) }}
              </span>
            </span>
            <span class="row-preview">{{ item.latestMessage?.text || "（暂无消息）" }}</span>
            <span class="row-meta">
              <span>{{ item.unreadCustomerCount > 0 ? `${item.unreadCustomerCount} 条未读` : "已读" }}</span>
              <span v-if="item.handoff?.assignedUser?.username">{{ item.handoff.assignedUser.username }}</span>
              <span v-if="item.latestMessageAt">{{ new Date(item.latestMessageAt).toLocaleString() }}</span>
            </span>
          </button>

          <button v-if="nextCursor" class="support-load-more" :disabled="listLoadingMore" @click="loadConversations(false)">
            {{ listLoadingMore ? "加载中…" : "加载更多" }}
          </button>

          <div v-if="!listLoading && conversations.length === 0" class="wf-empty">
            <div><strong>当前范围没有会话</strong><p>切换范围或等待新的入站消息。</p></div>
          </div>
        </div>
      </aside>

      <main class="support-detail">
        <template v-if="!selectedId">
          <div class="wf-empty detail-empty">
            <div><strong>选择一个会话</strong><p>左侧列表展示当前可见会话。</p></div>
          </div>
        </template>

        <template v-else>
          <header class="detail-head">
            <div class="detail-person">
              <strong>{{ contactName(selected) }}</strong>
              <span class="wf-muted">{{ selected?.channel }}{{ selected?.contact.channelContactId ? " · " + selected.contact.channelContactId : "" }}</span>
            </div>
            <div class="detail-actions">
              <span v-if="handoffState" class="wf-status" :class="handoffState.status === 'HUMAN_ACTIVE' ? 'accent' : handoffState.status === 'HANDOFF_PENDING' || handoffState.status === 'TRANSFER_PENDING' ? 'warn' : 'good'">
                {{ handoffStatusLabel(handoffState.status) }}
              </span>
              <span v-else-if="selected?.handoff" class="wf-status neutral">{{ handoffStatusLabel(selected.handoff.status) }}</span>

              <button v-if="canActOnCurrent" class="wf-button compact" :disabled="actionBusy" @click="openFinish">结束</button>
              <button v-if="canActOnCurrent" class="wf-button compact" :disabled="actionBusy" @click="openTransfer">转交</button>
              <button v-if="canActOnCurrent" class="wf-button compact" :disabled="actionBusy" @click="doRelease">释放</button>
              <button v-if="!handoffState && selected?.permissions.canManualTakeover" class="wf-button primary compact" :disabled="actionBusy || detailLoading" @click="doTakeOver">人工接管</button>
              <button v-if="handoffState?.status === 'HANDOFF_PENDING' && handoffState.canClaim" class="wf-button primary compact" :disabled="actionBusy || detailLoading" @click="doClaim">认领</button>
              <button v-if="handoffState?.status === 'TRANSFER_PENDING' && handoffState.canRejectTransfer" class="wf-button compact" :disabled="actionBusy || detailLoading" @click="doRejectTransfer">拒绝转交</button>
            </div>
          </header>

          <div v-if="detailError" class="wf-error detail-error">
            <span>{{ detailError }}</span>
            <button class="wf-button compact" @click="selectedId && loadHandoff(selectedId)">重试</button>
          </div>

          <div v-if="detail?.briefing" class="brief">
            <span class="brief-label">交接简报</span>
            <p>{{ briefingText(detail.briefing) }}</p>
            <div v-if="detail.briefing.confirmedFacts.length">
              <span class="brief-label">已确认</span>
              <span v-for="fact in detail.briefing.confirmedFacts" :key="fact.key">{{ factLabel(fact) }}；</span>
            </div>
            <div v-if="detail.activeTransferNote">
              <span class="brief-label">转交留言</span>
              <span>{{ detail.activeTransferNote }}</span>
            </div>
          </div>

          <section class="thread">
            <button v-if="transcriptNextCursor && !transcriptLoading" class="load-older" :disabled="transcriptLoadingMore" @click="loadOlder">
              {{ transcriptLoadingMore ? "加载中…" : "加载更早消息" }}
            </button>

            <div v-if="transcriptError" class="wf-error thread-error">
              <span>{{ transcriptError }}</span>
              <button class="wf-button compact" @click="selectedId && loadTranscript(selectedId)">重试</button>
            </div>

            <div v-if="transcriptLoading" class="messages">
              <div v-for="i in 4" :key="i" class="message-row skeleton"></div>
            </div>
            <div v-else-if="transcript.length === 0" class="wf-empty">暂无消息记录</div>
            <div v-else class="messages">
              <div v-for="message in transcript" :key="message.messageId" class="message-row">
                <div class="bubble-row" :class="messageBubbleClass(message)">
                  <div class="bubble-wrap">
                    <div class="bubble" :class="{ media: Boolean(message.mediaId), long: (message.text?.length ?? 0) > 120 }">
                      <MediaImage v-if="message.mediaId && message.contentType === 'image'" :media-id="message.mediaId" :alt="message.mediaDescription || '图片消息'" />
                      <span v-else-if="message.contentType === 'voice'" class="wf-subtle">{{ message.text || message.mediaDescription || "〔语音消息〕转写不可用" }}</span>
                      <span v-else-if="message.mediaId" class="wf-subtle">{{ message.mediaDescription || "媒体消息" }}</span>
                      <span v-else>{{ message.text || "—" }}</span>
                    </div>
                    <div class="bubble-meta">
                      <span>{{ messageTime(message.occurredAt) }}</span>
                      <span v-if="message.actorType === 'user' && message.direction === 'outbound'">人工</span>
                      <span v-else-if="message.actorType === 'agent'">Agent</span>
                      <span v-else-if="message.actorType === 'system'">系统</span>
                      <span v-if="message.sendState === 'failed' || message.processingState === 'failed'" class="bad">失败</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="composer">
              <template v-if="canReply">
                <textarea v-model="composerText" class="wf-textarea" rows="2" placeholder="输入人工回复，发送给客户…" :disabled="sending" @keydown.enter.exact.prevent="sendReply"></textarea>
                <div class="composer-actions">
                  <span class="wf-muted">Enter 发送</span>
                  <button class="wf-button primary compact" :disabled="sending || !composerText.trim()" @click="sendReply">{{ sending ? "发送中…" : "发送" }}</button>
                </div>
              </template>
              <div v-else class="takeover-bar">
                <div>
                  <strong>{{ handoffState?.status === "HANDOFF_PENDING" || handoffState?.status === "TRANSFER_PENDING" ? "等待操作员认领" : handoffState?.status === "HUMAN_ACTIVE" ? "当前由其他操作员处理" : "Agent 自动处理中" }}</strong>
                  <span class="wf-muted">认领后可人工回复；需要人工处理时请点击“人工接管”。</span>
                </div>
              </div>
            </div>
          </section>


        </template>
      </main>
    <aside class="support-context">
      <div v-if="contextLoading" class="skeleton"></div>
      <div v-else>
        <div v-if="contextError" class="wf-error"><span>{{ contextError }}</span></div>

        <div class="context-section">
          <div class="context-head"><strong>联系人</strong></div>
          <div v-if="profile" class="context-body">
            <div><span class="wf-muted">显示名</span> {{ contactName(selected) }}</div>
            <div><span class="wf-muted">备注</span> {{ profile.note || "—" }}</div>
            <div><span class="wf-muted">标签</span> {{ profile.tags?.length ? profile.tags.join("、") : "—" }}</div>
            <div><span class="wf-muted">Agent</span> {{ profile.agentEnabled === false ? "已停用" : "启用" }}</div>
          </div>
          <div v-else class="context-body wf-subtle">—</div>
        </div>

        <div class="context-section">
          <div class="context-head"><strong>记忆</strong><button class="wf-link" @click="openMemoryForm">添加</button></div>
          <div v-if="memories.length === 0" class="context-body wf-subtle">暂无记忆</div>
          <div v-else class="context-body">
            <div v-for="memory in memories.slice(0, 20)" :key="memory.memoryId" class="memory-item">
              <div class="memory-line">
                <span class="wf-status" :class="memoryTone(memory.status)">{{ memoryStatusLabel(memory.status) }}</span>
                <span class="wf-muted">{{ memoryKindLabel(memory.kind) }}</span>
                <span class="wf-muted">重要度 {{ memory.importance ?? 3 }}</span>
                <code>{{ memory.memoryKey }}</code>
              </div>
              <div class="memory-content">{{ memory.content }}</div>
              <div v-if="memory.status === 'candidate' || memory.status === 'active'" class="memory-actions">
                <button v-if="memory.status === 'candidate'" class="wf-link" @click="doMemoryAction(memory, 'activate')">激活</button>
                <button v-if="memory.status === 'candidate' || memory.status === 'active'" class="wf-link" @click="doMemoryAction(memory, 'invalidate')">失效</button>
              </div>
            </div>
          </div>
        </div>

        <div class="context-section">
          <div class="context-head"><strong>知识证据</strong></div>
          <div v-if="evidence.length === 0" class="context-body wf-subtle">暂无知识依据</div>
          <div v-else class="context-body">
            <div v-for="item in evidence" :key="item.evidenceId" class="evidence-item">
              <strong>{{ item.title }}</strong>
              <span>{{ item.excerpt }}</span>
              <span class="wf-subtle">{{ item.provenance === "human_selected" ? "人工固定" : "Agent 检索" }}</span>
            </div>
          </div>
        </div>
      </div>
    </aside>
    </div>

    <!-- transfer modal -->
    <div v-if="transferOpen" class="wf-modal-mask" @click.self="transferOpen = false">
      <div class="wf-modal">
        <div class="wf-modal-head"><h3>转交会话</h3><button class="wf-icon-button" @click="transferOpen = false"><SupportIcon name="close" /></button></div>
        <div class="wf-modal-body">
          <div class="support-tabs">
            <button class="support-tab" :class="{ active: transferTargetType === 'user' }" @click="transferTargetType = 'user'; transferTargetId = ''">转交操作员</button>
            <button class="support-tab" :class="{ active: transferTargetType === 'queue' }" :disabled="!hasMobileHandoff" @click="transferTargetType = 'queue'; transferTargetId = ''">转交队列</button>
          </div>
          <div v-if="transferTargetType === 'user'" class="assignee-list">
            <button v-for="user in transferUsers" :key="user.userId" class="assignee-row" :class="{ active: transferTargetId === user.userId }" @click="transferTargetId = user.userId">{{ user.displayName || user.username }}</button>
            <div v-if="transferUsers.length === 0" class="wf-subtle">暂无其他操作员</div>
          </div>
          <div v-else class="assignee-list">
            <button v-for="queue in transferQueues" :key="queue.queueId" class="assignee-row" :class="{ active: transferTargetId === queue.queueId }" @click="transferTargetId = queue.queueId">
              <strong>{{ queue.displayName }}</strong>
              <span class="wf-subtle">{{ queue.shortDescription || queue.queueId }}</span>
            </button>
            <div v-if="transferQueues.length === 0" class="wf-subtle">暂无可用队列</div>
          </div>
          <label class="wf-field"><span>转交说明（可选）</span><textarea v-model="transferReason" rows="3" class="wf-textarea"></textarea></label>
          <div v-if="transferError" class="wf-error">{{ transferError }}</div>
        </div>
        <div class="wf-modal-foot">
          <button class="wf-button" :disabled="transferBusy" @click="transferOpen = false">取消</button>
          <button class="wf-button primary" :disabled="transferBusy || !transferTargetId" @click="submitTransfer">{{ transferBusy ? "转交中…" : "确认转交" }}</button>
        </div>
      </div>
    </div>

    <!-- finish modal -->
    <div v-if="finishOpen" class="wf-modal-mask" @click.self="finishOpen = false">
      <div class="wf-modal">
        <div class="wf-modal-head"><h3>结束人工处理</h3><button class="wf-icon-button" @click="finishOpen = false"><SupportIcon name="close" /></button></div>
        <div class="wf-modal-body">
          <label class="wf-field">
            <span>处理结果</span>
            <select v-model="finishResult" class="wf-select">
              <option v-for="option in handoffResultOptions()" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
          <div v-if="finishError" class="wf-error">{{ finishError }}</div>
        </div>
        <div class="wf-modal-foot">
          <button class="wf-button" :disabled="finishBusy" @click="finishOpen = false">取消</button>
          <button class="wf-button primary" :disabled="finishBusy" @click="submitFinish">{{ finishBusy ? "提交中…" : "确认结束" }}</button>
        </div>
      </div>
    </div>

    <!-- memory modal -->
    <div v-if="memoryFormOpen" class="wf-modal-mask" @click.self="memoryFormOpen = false">
      <div class="wf-modal">
        <div class="wf-modal-head"><h3>添加记忆</h3><button class="wf-icon-button" @click="memoryFormOpen = false"><SupportIcon name="close" /></button></div>
        <div class="wf-modal-body">
          <label class="wf-field">
            <span>类型</span>
            <select v-model="memoryKind" class="wf-select">
              <option value="fact">事实</option>
              <option value="preference">偏好</option>
              <option value="relationship">关系</option>
            </select>
          </label>
          <label class="wf-field">
            <span>记忆键</span>
            <input v-model="memoryKey" class="wf-input" placeholder="如 product_version" />
            <span class="wf-subtle">小写字母、数字、_ . -，长度 1–100</span>
          </label>
          <label class="wf-field">
            <span>内容</span>
            <textarea v-model="memoryContent" rows="3" class="wf-textarea"></textarea>
          </label>
          <label class="wf-field">
            <span>重要度</span>
            <select v-model="memoryImportance" class="wf-select">
              <option :value="1">1 - 很低</option>
              <option :value="2">2 - 低</option>
              <option :value="3">3 - 普通</option>
              <option :value="4">4 - 重要</option>
              <option :value="5">5 - 关键</option>
            </select>
          </label>
          <div v-if="memoryError" class="wf-error">{{ memoryError }}</div>
        </div>
        <div class="wf-modal-foot">
          <button class="wf-button" :disabled="memoryBusy" @click="memoryFormOpen = false">取消</button>
          <button class="wf-button primary" :disabled="memoryBusy" @click="submitMemory">{{ memoryBusy ? "保存中…" : "保存" }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.support-page {
  padding: 12px;
}

.support-layout {
  height: calc(100vh - 160px);
  min-height: 520px;
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr) 280px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.support-list {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
}

.support-toolbar {
  min-height: 46px;
  display: flex;
  align-items: center;
  padding: 8px;
  border-bottom: 1px solid var(--border);
}

.support-tabs {
  display: flex;
  gap: 4px;
}

.support-tab {
  min-height: 28px;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
}

.support-tab:hover {
  color: var(--text);
}

.support-tab.active {
  color: var(--primary);
  background: var(--primary-soft);
  font-weight: 600;
}

.support-tab:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.support-rows {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.support-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  min-height: 68px;
  padding: 10px 12px 10px 16px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.support-row:hover,
.support-row.active {
  background: var(--surface-hover);
}

.support-row.active {
  box-shadow: inset 2px 0 var(--primary);
}

.row-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.row-title strong {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.row-preview {
  overflow: hidden;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.row-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--text-muted);
  font-size: 12px;
}

.support-load-more {
  display: block;
  width: 100%;
  padding: 8px;
  border: 0;
  background: transparent;
  color: var(--primary);
  cursor: pointer;
  font-size: 12px;
}

.skeleton {
  background: var(--surface-soft);
  border-radius: var(--radius);
  color: transparent;
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .55; }
}

.support-row.skeleton {
  height: 68px;
  margin-bottom: 1px;
}

.message-row.skeleton {
  width: 40%;
  height: 36px;
  margin: 12px 0;
  border-radius: 12px;
}

.support-detail {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  overflow: hidden;
}

.detail-empty {
  min-height: 100%;
}

.detail-head {
  min-height: 54px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
}

.detail-person {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.detail-person strong {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail-error {
  margin: 8px 12px 0;
}

.brief {
  display: grid;
  gap: 4px;
  padding: 12px 16px;
  background: var(--surface-soft);
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}

.brief-label {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 700;
}

.brief p {
  margin: 0;
  line-height: 1.6;
}

.thread {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--border);
}

.load-older {
  width: 100%;
  padding: 8px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--primary);
  cursor: pointer;
  font-size: 12px;
}

.thread-error {
  margin: 8px 12px 0;
}

.messages {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 16px;
}

.message-row {
  margin: 12px 0;
}

.bubble-row {
  display: flex;
}

.bubble-row.me {
  justify-content: flex-end;
}

.bubble-wrap {
  max-width: 72%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.bubble-row.me .bubble-wrap {
  align-items: flex-end;
}

.bubble {
  padding: 8px 13px;
  border-radius: 12px 12px 12px 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  font-size: 13px;
  line-height: 1.55;
  word-break: break-word;
  white-space: pre-wrap;
}

.bubble.long {
  max-width: 82%;
}

.bubble-row.me .bubble {
  background: var(--primary);
  color: #fff;
  border-color: transparent;
  border-radius: 12px 12px 4px 12px;
}

.bubble-row.agent .bubble {
  background: var(--primary-soft);
  color: var(--text);
  border-color: transparent;
}

.bubble.media {
  padding: 3px;
}

.bubble-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.bubble-row.me .bubble-meta {
  justify-content: flex-end;
}

.bubble-meta .bad {
  color: var(--danger);
  font-weight: 600;
}

.composer {
  padding: 12px;
  border-top: 1px solid var(--border);
  background: var(--surface);
}

.composer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
}

.takeover-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--surface-soft);
}

.takeover-bar div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}

.support-context {
  min-height: 0;
  overflow: auto;
  border-left: 1px solid var(--border);
  background: var(--surface);
}

.context-section {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.context-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.context-head strong {
  font-size: 13px;
}

.context-body {
  display: grid;
  gap: 4px;
  font-size: 13px;
}

.memory-item,
.evidence-item {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}

.memory-item:last-child,
.evidence-item:last-child {
  border-bottom: 0;
}

.memory-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.memory-line code {
  font-size: 12px;
  color: var(--text-secondary);
}

.memory-content {
  margin-top: 2px;
  line-height: 1.5;
}

.memory-actions {
  display: flex;
  gap: 12px;
  margin-top: 4px;
}

.evidence-item {
  display: grid;
  gap: 4px;
}

.assignee-list {
  display: grid;
  gap: 4px;
  margin: 12px 0;
}

.assignee-row {
  min-height: 40px;
  padding: 8px 12px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: transparent;
  text-align: left;
  cursor: pointer;
  font-size: 13px;
}

.assignee-row:hover {
  background: var(--surface-hover);
}

.assignee-row.active {
  border-color: var(--primary);
  background: var(--primary-soft);
}

.assignee-row span {
  display: block;
}
</style>
