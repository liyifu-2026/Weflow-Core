<script setup lang="ts">
/**
 * 会话工作台（组合层）：
 * 全部业务逻辑（列表加载/选择/SSE/增量刷新/接管/转交/发送/上传）保留在此，
 * 视觉拆分为 components/conversations/ 子组件（列表/聊天窗格/气泡/输入区/
 * 接管条/Inspector 面板/决策轨迹抽屉）。逻辑零改动，仅重写视觉与结构。
 */
import { confirmDialog } from "../components/confirm-dialog";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { useWeflowAuthStore } from "../auth-store";
import AssetPicker, { type AssetPickResult } from "../components/AssetPicker.vue";
import type { AssetItem } from "../assets/api";
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
import { statusTone } from "../components/status-tone";
import { useEscClose } from "../composables/use-esc-close";
import { agentDisplayName, contactDisplayName, factLabel, reasonLabel } from "../labels";
import { knowledgeTarget } from "../navigation-context";
import { useConversationWorkspaceStore } from "../stores/conversation-workspace";
import ConversationList from "../components/conversations/ConversationList.vue";
import ChatPane from "../components/conversations/ChatPane.vue";
import InspectorPanel from "../components/conversations/InspectorPanel.vue";
import SessionTraceDrawer from "../components/conversations/SessionTraceDrawer.vue";
import {
  actorLabel,
  priority,
  riskLabel,
  rowSummary,
  rowTimeLabel,
  type Conversation,
  type Evidence,
  type Message,
  type SectionScope,
} from "../components/conversations/types";

const auth = useWeflowAuthStore();
const route = useRoute();
const router = useRouter();
const workspaceStore = useConversationWorkspaceStore();
const workspace = workspaceStore.open(auth.user?.userId || "anonymous");
// Console 能力门：conversationPermissions 未开启 → 旧双 Tab + 本地推导；
// 开启 → 三区列表 + 服务端 permissions 驱动（字段缺失即只读，fail-safe）。
const capabilities = ref<Record<string, boolean> | null>(null);
const conversationPermissionsEnabled = computed(
  () => capabilities.value?.conversationPermissions === true,
);
// 三区（capability 开启且非搜索态时使用；排序由 Core scope 合同保证）
const sectionAttention = ref<Conversation[]>([]);
const sectionMine = ref<Conversation[]>([]);
const sectionOthers = ref<Conversation[]>([]);
const listNextCursors = ref<Record<SectionScope, string | null>>({
  attention: null,
  mine: null,
  others: null,
});
const listLoadingMore = ref<Record<SectionScope, boolean>>({
  attention: false,
  mine: false,
  others: false,
});
const conversations = ref<Conversation[]>([]);
const selectedId = ref("");
const messages = ref<Message[]>([]);
const conversationRevision = ref(0);
const nextCursor = ref<string | null>(null);
const loadingOlder = ref(false);
const handoff = ref<any>(null);
// 会话模式可视化（Phase 3/4）：session episode 状态 + 唤醒计划 + 决策轨迹
const agentSession = ref<{
  state: string;
  roundsUsed: number;
  roundBudget: number;
  startedAt?: string;
  closedAt?: string | null;
  closureSummary?: string | null;
} | null>(null);
const sessionWakes = ref<
  { wakeId: number; turnId: string; kind: string; status: string; wakeAt: string; nudgeText?: string | null }[]
>([]);
const sessionTraceTurnId = ref<string | null>(null);
const sessionTrace = ref<{
  turn: { turnId: string; status: string; model?: string; traceId?: string; startedAt?: string; completedAt?: string } | null;
  events: { eventType: string; reasonCode?: string | null; payload?: Record<string, any>; createdAt: string }[];
} | null>(null);
const sessionTraceOpen = ref(false);
// 「AI 正在思考」实时感（Phase 4）：轮询进行中的 turn 事件 + 思维链
const liveThinking = ref<{
  turnId: string;
  status: string;
  startedAt?: string;
  lastEventLabel?: string;
  reasoning?: string | null;
} | null>(null);
let livePollTimer: ReturnType<typeof setInterval> | null = null;
const LIVE_POLL_MS = 2_000;
const STAGE_LABELS: Record<string, string> = {
  triaged: "正在判断消息类型…",
  context_built: "正在装配上下文…",
  tool_checkpoint_persisted: "正在规划工具调用…",
  knowledge_retrieved: "知识库检索完成",
  tool_completed: "工具执行完成",
  policy_decided: "正在整理回复…",
  draft_generated: "正在生成回复…",
  model_reasoning: "正在深入思考…",
};
function liveStageLabel(eventType?: string): string {
  if (!eventType) return "正在处理…";
  return STAGE_LABELS[eventType] ?? "正在处理…";
}
async function pollLiveTurn(conversationId: string) {
  try {
    const result = await api<any>(
      `/api/v1/agent/live-turn/${encodeURIComponent(conversationId)}`,
    );
    liveThinking.value = result?.live
      ? {
          turnId: result.live.turnId,
          status: result.live.status,
          startedAt: result.live.startedAt,
          lastEventLabel: liveStageLabel(result.live.lastEvent?.eventType),
          reasoning: result.live.reasoning ?? null,
        }
      : null;
  } catch {
    /* 轮询失败静默：下个周期重试 */
  }
}
function startLivePolling(conversationId: string) {
  stopLivePolling();
  void pollLiveTurn(conversationId);
  livePollTimer = setInterval(() => void pollLiveTurn(conversationId), LIVE_POLL_MS);
}
function stopLivePolling() {
  if (livePollTimer) {
    clearInterval(livePollTimer);
    livePollTimer = null;
  }
  liveThinking.value = null;
}
const sessionTraceLoading = ref(false);
const profile = ref<any>(null);
const evidence = ref<Evidence[]>([]);
const assignees = ref<any[]>([]);
const search = computed({
  get: () => workspace.search,
  set: (value: string) => (workspace.search = value),
});
const replyText = computed({
  get: () => workspace.replyDraft,
  set: (value: string) => (workspace.replyDraft = value),
});
const inspectorOpen = ref(false);
const inspectorCollapsed = ref(
  localStorage.getItem("wf-inspector") === "collapsed",
);
// Race-condition 保护：快速切换会话时，旧会话的迟到响应必须被丢弃。
let selectionGeneration = 0;
const inspectorView = ref<
  "context" | "brief" | "evidence" | "customer" | "history"
>("context");
// 历史对话：Inspector 内只读查看该联系人的其他会话（不离开当前 Workspace）
// 使用正式 Contact History 合同（游标分页，只读；不可接管或回复）
type HistoryConversation = {
  conversationId: string;
  latestMessageAt: string | null;
  latestMessageText?: string | null;
  handoffStatus?: string | null;
};
const historyConversations = ref<HistoryConversation[]>([]);
const historyLoading = ref(false);
const historyNextCursor = ref<string | null>(null);
const historySelectedId = ref("");
const historyMessages = ref<Message[]>([]);
const historyMessagesLoading = ref(false);
const historyMessagesNextCursor = ref<string | null>(null);
const transferOpen = ref(false);
const transferTarget = ref("");
const settingsOpen = ref(false);
const anyOverlayOpen = computed(
  () =>
    inspectorOpen.value || transferOpen.value || settingsOpen.value,
);
useEscClose(anyOverlayOpen, () => {
  inspectorOpen.value = false;
  transferOpen.value = false;
  settingsOpen.value = false;
});

// Inspector：统一右侧上下文检查器。顶层为「当前上下文」，
// 点击条目进入深度视图（交接说明/回答依据/客户资料），返回键回顶层。
function openInspector(
  view: "context" | "brief" | "evidence" | "customer" | "history",
) {
  inspectorView.value = view;
  setInspectorCollapsed(false);
  inspectorOpen.value = true;
  if (view === "history") void loadHistory();
}
// 收起偏好记忆（UX-DECISIONS §1）：手动收起后不再随选中自动展开
function setInspectorCollapsed(collapsed: boolean) {
  inspectorCollapsed.value = collapsed;
  localStorage.setItem("wf-inspector", collapsed ? "collapsed" : "open");
}
function closeInspector() {
  setInspectorCollapsed(true);
  inspectorOpen.value = false;
}
// 联系人的历史会话（只读，Inspector 内查看；游标分页）
async function loadHistory(append = false) {
  if (!selectedId.value || historyLoading.value) return;
  const contactId = selected.value?.contact?.contactId;
  if (!contactId) return;
  historyLoading.value = true;
  try {
    if (!append) {
      historyConversations.value = [];
      historyNextCursor.value = null;
    }
    const cursor = append ? historyNextCursor.value : null;
    const result = await api<{
      conversations: HistoryConversation[];
      nextCursor: string | null;
    }>(
      `/api/v1/contacts/${encodeURIComponent(contactId)}/conversations?limit=20${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`,
    );
    historyConversations.value = [
      ...historyConversations.value,
      ...(result.conversations ?? []),
    ];
    historyNextCursor.value = result.nextCursor ?? null;
  } catch {
    historyConversations.value = [];
  } finally {
    historyLoading.value = false;
  }
}
async function openHistoryConversation(id: string) {
  historySelectedId.value = id;
  historyMessages.value = [];
  historyMessagesNextCursor.value = null;
  await loadMoreHistoryMessages(id);
}
async function loadMoreHistoryMessages(id = historySelectedId.value) {
  if (!id || historyMessagesLoading.value) return;
  historyMessagesLoading.value = true;
  try {
    const cursor = historyMessagesNextCursor.value;
    const result = await api<{
      messages: Message[];
      nextCursor?: string | null;
    }>(
      `/api/v1/conversations/${encodeURIComponent(id)}/messages?limit=100${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`,
    );
    historyMessages.value = [
      ...historyMessages.value,
      ...(result.messages ?? []),
    ];
    historyMessagesNextCursor.value = result.nextCursor ?? null;
  } catch {
    // 静默；下一轮重试
  } finally {
    historyMessagesLoading.value = false;
  }
}

function inspectorBack() {
  if (inspectorView.value === "history" && historySelectedId.value) {
    historySelectedId.value = "";
    historyMessages.value = [];
    return;
  }
  inspectorView.value = "context";
}
const inspectorTitle = computed(() => {
  switch (inspectorView.value) {
    case "context":
      return "当前上下文";
    case "brief":
      return "交接说明";
    case "evidence":
      return "回答依据";
    case "customer":
      return "客户资料";
    case "history":
      return "历史对话";
  }
});
const inspectorDepth = computed(() => {
  if (inspectorView.value === "context") return 0;
  if (inspectorView.value === "history" && historySelectedId.value) return 2;
  return 1;
});
const sending = ref(false);
const retryBusy = ref(false);
const actionBusy = ref(false);
// 接管转场：成功瞬间置 true 触发 180ms 状态转场（Composer/接管条 fade+slide）
const takeoverTransition = ref(false);
const loadingList = ref(true);
const loadingConversation = ref(false);
const listError = ref("");
const detailError = ref("");
const note = ref("");
const tags = ref("");
const messagePane = ref<HTMLElement | null>(null);
const messagePaneHost = ref<InstanceType<typeof ChatPane> | null>(null);
watch(messagePaneHost, (host) => {
  // ChatPane defineExpose 的滚动容器：消息锚定/跟随滚动都依赖它
  messagePane.value = (host?.messagePane as HTMLElement | null) ?? null;
});

const selected = computed(() =>
  [
    ...sectionAttention.value,
    ...sectionMine.value,
    ...sectionOthers.value,
    ...conversations.value,
  ].find((item) => item.conversationId === selectedId.value),
);
// 服务端 permissions（fail-safe：capability 开启后字段缺失 → 该操作只读）
const selectedPermissions = computed(
  () => selected.value?.permissions ?? null,
);
// AGENT_ACTIVE 才能 Manual Takeover；pending 走 Claim、transfer_pending 走 Accept（命令语义精确）
const canManualTakeover = computed(() =>
  conversationPermissionsEnabled.value
    ? (selectedPermissions.value?.canManualTakeover ?? false)
    : !handoff.value,  // 仅 AGENT_ACTIVE（无 handoff）显示接管条；resolve 后 Agent 自动恢复，直接展示 Composer
);
const canTransfer = computed(() =>
  conversationPermissionsEnabled.value
    ? (selectedPermissions.value?.canTransfer ?? false)
    : mine.value,
);
const canFinish = computed(() =>
  conversationPermissionsEnabled.value
    ? (selectedPermissions.value?.canFinish ?? false)
    : mine.value,
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
    : replyText.value.trim() &&
      handoff.value?.state?.status !== "pending" &&
      !(handoff.value?.state?.status === "in_progress" && !mine.value),
);
const company = computed(
  () =>
    String(
      profile.value?.companyName ||
        profile.value?.company ||
        profile.value?.organization ||
        "",
    ) || "",
);
/** 会话是否为群聊：Core 由 channel ref（@chatroom）派生并投影 chatType */
function isGroup(item: Conversation | undefined | null): boolean {
  return item?.chatType === "group";
}
const selectedIsGroup = computed(() => isGroup(selected.value));
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
const doneWakes = computed(() =>
  sessionWakes.value.filter((w) => w.status === "done").slice(0, 2),
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
// 决策轨迹入口：取最近一次已回复的 turn（回复消息 id 里带 turnId）
const lastReplyTurnId = computed(() => {
  const last = [...messages.value]
    .reverse()
    .find((m) => m.actorType === "agent" && m.messageId.startsWith("agent-message:turn:"));
  if (!last) return null;
  const match = last.messageId.match(/^agent-message:(turn:[^:]+.*?):\d+$/);
  return match?.[1] ?? null;
});
async function openSessionTrace(turnId: string | null) {
  if (!turnId) return;
  sessionTraceOpen.value = true;
  sessionTraceLoading.value = true;
  sessionTraceTurnId.value = turnId;
  try {
    sessionTrace.value = await api<any>(
      `/api/v1/agent/decision-trace/${encodeURIComponent(turnId)}`,
    );
  } catch {
    sessionTrace.value = { turn: null, events: [] };
  } finally {
    sessionTraceLoading.value = false;
  }
}
const TRACE_EVENT_LABELS: Record<string, string> = {
  ownership_checked: "领取轮次",
  triaged: "分流",
  policy_decided: "决策",
  reply_persisted: "回复落库",
  context_built: "上下文装配",
  tool_planned: "工具规划",
  tool_completed: "工具完成",
  validation_failed: "校验失败",
  suppressed: "策略抑制",
};

function ownershipLabel() {
  const state = handoff.value?.state;
  if (!state) return "Agent 处理中";
  if (state.status === "pending") return "等待接手";
  if (state.status === "in_progress")
    return mine.value ? "我处理中" : "其他客服处理中";
  if (state.status === "resolved") return "已完成";
  return handoffLabel(state.status);
}
function handoffLabel(status?: string) {
  return status === "pending"
    ? "等待接手"
    : status === "in_progress"
      ? "处理中"
      : status === "resolved"
        ? "已完成"
        : "Agent 处理中";
}

// Core 对 contractVersion=2 会话返回 Mobile 序列化的状态大写值，
// 桌面端状态判断统一用小写；进入 UI 前归一化，避免“按钮存在却永远不显示”。
const HANDOFF_STATUS_NORMALIZE: Record<string, string> = {
  HANDOFF_PENDING: "pending",
  TRANSFER_PENDING: "transfer_pending",
  HUMAN_ACTIVE: "in_progress",
  HUMAN_FINISHED: "resolved",
};
function normalizeHandoffStatus(status?: string | null): string | undefined {
  if (!status) return undefined;
  return HANDOFF_STATUS_NORMALIZE[status] ?? status;
}

// 左侧列表：微信式单列（头像+昵称+摘要+未读），按风险/交接/未读排序。
const flatConversations = computed<Conversation[]>(() => {
  const rows = conversationPermissionsEnabled.value
    ? [...sectionAttention.value, ...sectionMine.value, ...sectionOthers.value]
    : conversations.value;
  const seen = new Set<string>();
  const merged: Conversation[] = [];
  for (const item of rows) {
    if (seen.has(item.conversationId)) continue;
    seen.add(item.conversationId);
    merged.push(item);
  }
  return merged.sort((a, b) => priority(b) - priority(a));
});

// 三区会话（问题 4：等待处理 / 我处理的 / 其他对话，颜色区分）。
// 与 mobile 端一致：attention=等待处理（红）、mine=我处理的（蓝）、others=其他（灰）。
const queueSections = computed<Array<{ key: SectionScope; title: string; tone: string; items: Conversation[] }>>(() => {
  const seen = new Set<string>();
  const pick = (rows: Conversation[]) => {
    const out: Conversation[] = [];
    for (const item of rows) {
      if (seen.has(item.conversationId)) continue;
      seen.add(item.conversationId);
      out.push(item);
    }
    return out;
  };
  return [
    { key: "attention", title: "等待处理", tone: "attention", items: pick(sectionAttention.value) },
    { key: "mine", title: "我处理的", tone: "mine", items: pick(sectionMine.value) },
    { key: "others", title: "其他对话", tone: "others", items: pick(sectionOthers.value) },
  ];
});

// 搜索合一（UX-DECISIONS §1）：单一搜索框，空态为队列，输入同搜会话与联系人。
// 联系人搜索复用同一 search 词（原「联系人」Tab 已删除）。
type ContactSummary = {
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
const contacts = ref<ContactSummary[]>([]);
const contactsNextCursor = ref<string | null>(null);
const contactsLoading = ref(false);
const contactsLoadingMore = ref(false);
const contactsError = ref("");
async function loadList(selectFirst = false) {
  listError.value = "";
  try {
    if (search.value.trim()) {
      conversations.value = (
        await api<{ conversations: Conversation[] }>(
          `/api/v1/conversations/search?q=${encodeURIComponent(search.value.trim())}&limit=50`,
        )
      ).conversations;
    } else if (conversationPermissionsEnabled.value) {
      // 三区由 Core scope 合同计算并排序（attention 按风险+handoff 权重+未读）。
      // 工作区视图在 Core 端仅返回白名单客户（agentEnabled=true）；
      // 联系人视图不调用本接口（用 /api/v1/contacts）。
      const [attention, mine, others] = await Promise.all([
        api<{ conversations: Conversation[]; nextCursor?: string | null }>(
          "/api/v1/conversations?limit=100&scope=attention&agentEnabled=true",
        ),
        api<{ conversations: Conversation[]; nextCursor?: string | null }>(
          "/api/v1/conversations?limit=100&scope=mine&agentEnabled=true",
        ),
        api<{ conversations: Conversation[]; nextCursor?: string | null }>(
          "/api/v1/conversations?limit=100&scope=others&agentEnabled=true",
        ),
      ]);
      sectionAttention.value = attention.conversations ?? [];
      sectionMine.value = mine.conversations ?? [];
      sectionOthers.value = others.conversations ?? [];
      listNextCursors.value = {
        attention: attention.nextCursor ?? null,
        mine: mine.nextCursor ?? null,
        others: others.nextCursor ?? null,
      };
      conversations.value = [];
    } else {
      conversations.value = (
        await api<{ conversations: Conversation[] }>(
          "/api/v1/conversations?limit=100",
        )
      ).conversations;
    }
    const routeId = typeof route.query.id === "string" ? route.query.id : "";
    // 继续旧活优先：默认落「我处理的」第一条，其次等待处理，最后其他
    const firstInSections =
      sectionMine.value[0] ??
      sectionAttention.value[0] ??
      sectionOthers.value[0];
    const first = search.value.trim()
      ? conversations.value[0]
      : firstInSections;
    if (
      (selectFirst || !selectedId.value) &&
      (routeId || first?.conversationId)
    ) {
      await select(routeId || first!.conversationId, false);
    }
  } catch (reason) {
    listError.value =
      reason instanceof Error ? reason.message : "会话队列加载失败";
  } finally {
    loadingList.value = false;
  }
}

/** 分区「加载更多」：游标续页，追加去重 */
async function loadMoreSection(scope: SectionScope) {
  const cursor = listNextCursors.value[scope];
  if (!cursor || listLoadingMore.value[scope]) return;
  listLoadingMore.value[scope] = true;
  try {
    const result = await api<{
      conversations: Conversation[];
      nextCursor?: string | null;
    }>(
      `/api/v1/conversations?limit=100&scope=${scope}&agentEnabled=true&before=${encodeURIComponent(cursor)}`,
    );
    const target =
      scope === "attention"
        ? sectionAttention
        : scope === "mine"
          ? sectionMine
          : sectionOthers;
    const seen = new Set(target.value.map((item) => item.conversationId));
    target.value = [
      ...target.value,
      ...(result.conversations ?? []).filter(
        (item) => !seen.has(item.conversationId),
      ),
    ];
    listNextCursors.value[scope] = result.nextCursor ?? null;
  } catch {
    // 静默；下一轮重试
  } finally {
    listLoadingMore.value[scope] = false;
  }
}

// 单列列表底部的「加载更多」：对所有仍有游标的分区并发续页。
const hasMoreConversations = computed(() =>
  Object.values(listNextCursors.value).some(Boolean),
);
const loadingMoreConversations = computed(() =>
  Object.values(listLoadingMore.value).some(Boolean),
);
async function loadOlderConversations() {
  const scopes = Object.keys(listNextCursors.value) as SectionScope[];
  await Promise.all(
    scopes
      .filter((scope) => listNextCursors.value[scope])
      .map((scope) => loadMoreSection(scope)),
  );
}

// ---------- 联系人页（独立视图，仅只读浏览） ----------
async function loadContacts(append = false) {
  if (append ? contactsLoadingMore.value : contactsLoading.value) return;
  if (append) contactsLoadingMore.value = true;
  else contactsLoading.value = true;
  contactsError.value = "";
  try {
    const cursor = append ? contactsNextCursor.value : null;
    const query = new URLSearchParams();
    query.set("limit", "50");
    if (search.value.trim()) query.set("q", search.value.trim());
    if (cursor) query.set("before", cursor);
    const result = await api<{
      contacts: ContactSummary[];
      nextCursor: string | null;
    }>(`/api/v1/contacts?${query.toString()}`);
    const incoming = result.contacts ?? [];
    if (append) {
      const seen = new Set(contacts.value.map((c) => c.contactId));
      contacts.value = [
        ...contacts.value,
        ...incoming.filter((c) => !seen.has(c.contactId)),
      ];
    } else {
      contacts.value = incoming;
    }
    contactsNextCursor.value = result.nextCursor ?? null;
  } catch (reason) {
    contactsError.value =
      reason instanceof Error ? reason.message : "联系人加载失败";
  } finally {
    if (append) contactsLoadingMore.value = false;
    else contactsLoading.value = false;
  }
}
// 联系人搜索结果点击：清搜索回队列视图并选中对应会话
function selectContactAndSwitch(conversationId: string) {
  workspace.search = "";
  void select(conversationId);
}

// 搜索合一驱动：输入防抖 300ms，同时搜会话（loadList 搜索分支）与联系人。
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(search, (value) => {
  clearTimeout(searchTimer);
  const q = value.trim();
  if (!q) {
    contacts.value = [];
    contactsNextCursor.value = null;
    contactsError.value = "";
    void loadList();
    return;
  }
  searchTimer = setTimeout(() => {
    void loadList();
    void loadContacts();
  }, 300);
});

async function select(id: string, syncRoute = true) {
  if (!id) return;
  const generation = ++selectionGeneration;
  selectedId.value = id;
  // 选中即展开 Inspector（inline 第三栏，不再遮挡工作区）；
  // 用户手动收起后记忆偏好，不再自动弹出
  inspectorView.value = "context";
  if (!inspectorCollapsed.value) inspectorOpen.value = true;
  transferOpen.value = false;
  settingsOpen.value = false;
  if (syncRoute && route.query.id !== id) {
    await router.replace({ query: { id } });
  }
  loadingConversation.value = true;
  detailError.value = "";
  try {
    const [transcript, handoffResult, profileResult, evidenceResult, sessionStateResult, sessionWakesResult] =
      await Promise.all([
        api<any>(
          `/api/v1/conversations/${encodeURIComponent(id)}/messages?limit=100`,
        ),
        api<any>(
          `/api/v1/conversations/${encodeURIComponent(id)}/handoff`,
        ).catch((reason: any) =>
          reason.status === 404 ? null : Promise.reject(reason),
        ),
        api<any>(
          `/api/v1/conversations/${encodeURIComponent(id)}/contact-profile`,
        ),
        api<any>(
          `/api/v1/conversations/${encodeURIComponent(id)}/knowledge/evidence-tray`,
        ).catch(() => ({ evidence: [] })),
        api<any>(
          `/api/v1/agent/session-state/${encodeURIComponent(id)}`,
        ).catch(() => ({ session: null })),
        api<any>(`/api/v1/agent/session-wakes/${encodeURIComponent(id)}`).catch(
          () => ({ wakes: [] }),
        ),
      ]);
    // 代际检查：期间已切换到其他会话则丢弃本批数据。
    if (generation !== selectionGeneration) return;
    messages.value = transcript.messages;
    latestKnownMessageId.value = messages.value[0]?.messageId ?? "";
    conversationRevision.value = transcript.conversationRevision ?? 0;
    nextCursor.value = transcript.nextCursor ?? null;
    handoff.value = handoffResult?.handoff ?? null;
    if (handoff.value?.state?.status) {
      handoff.value.state.status =
        normalizeHandoffStatus(handoff.value.state.status) ??
        handoff.value.state.status;
    }
    startLivePolling(id);
    agentSession.value = sessionStateResult?.session ?? null;
    sessionWakes.value = sessionWakesResult?.wakes ?? [];
    sessionTraceOpen.value = false;
    sessionTrace.value = null;
    profile.value = profileResult.profile;
    evidence.value = evidenceResult.evidence ?? [];
    note.value = profile.value.note ?? "";
    tags.value = (profile.value.tags ?? []).join("、");
    const last = messages.value.at(-1);
    if (last)
      void api(`/api/v1/conversations/${encodeURIComponent(id)}/read`, {
        method: "POST",
        body: JSON.stringify({ lastReadMessageId: last.messageId }),
      });
    await nextTick();
    if (generation !== selectionGeneration) return;
    const targetMessage =
      typeof route.query.messageId === "string"
        ? document.getElementById(`message-${route.query.messageId}`)
        : null;
    // 切会话必达最新：仅 messageId 定位时去锚点，否则无条件滚到底
    if (targetMessage) targetMessage.scrollIntoView({ block: "center" });
    else scrollToLatest(() => generation === selectionGeneration);
  } catch (reason) {
    detailError.value =
      reason instanceof Error ? reason.message : "会话上下文加载失败";
  } finally {
    loadingConversation.value = false;
  }
  void autoCheckUnknownOutcomes();
}

async function transition(kind: "accept" | "take-over" | "resolve") {
  if (!selectedId.value) return;
  if (
    kind === "resolve" &&
    !await confirmDialog(
      "结束人工处理？\n\n后续客户再次发消息时，Agent 将重新负责。",
    )
  )
    return;
  actionBusy.value = true;
  try {
    await api(
      `/api/v1/conversations/${encodeURIComponent(selectedId.value)}/handoff/${kind}`,
      {
        method: "POST",
        body: JSON.stringify({
          // Manual Takeover 不要求原因（takeoverReason 可选）；resolve 保留既有话术
          ...(kind === "resolve"
            ? { summary: "桌面客服已完成处理" }
            : kind === "accept"
              ? { summary: "桌面客服接手" }
              : {}),
          clientRequestId: crypto.randomUUID(),
        }),
      },
    );
    if (kind === "take-over") {
      // 接管仪式：不整页重载——静默刷归属状态 + 列表，Composer 由转场动画淡入
      takeoverTransition.value = true;
      window.setTimeout(() => (takeoverTransition.value = false), 240);
      await Promise.all([refreshContextSilently(), loadList()]);
    } else {
      await Promise.all([select(selectedId.value), loadList()]);
    }
  } catch (reason) {
    if (kind === "take-over" && (reason as { status?: number })?.status === 409) {
      // 竞争失败是正常结果（§27）：静默刷新为「王工正在处理」只读，不弹错误
      await Promise.all([refreshContextSilently(), loadList()]);
      return;
    }
    detailError.value =
      reason instanceof Error ? reason.message : "接管操作失败";
  } finally {
    actionBusy.value = false;
  }
}
// 转交：两种责任转移（转客服 → 等待接受；转专业队列 → 释放进队列）。
// 状态全部来自 Core handoff.state，前端不模拟“转交成功”。
const transferQueues = ref<Array<{ queueId: string; displayName: string }>>([]);
const transferTargetType = ref<"user" | "queue">("user");
const transferReason = ref("");

async function openTransfer() {
  transferOpen.value = true;
  transferTarget.value = "";
  transferTargetType.value = "user";
  transferReason.value = "";
  try {
    const [assigneeResult, queueResult] = await Promise.all([
      api<{
        users: Array<{ userId: string; username: string; displayName?: string | null }>;
      }>("/api/v1/handoff-assignees"),
      api<{
        queues: Array<{ queueId: string; displayName: string; canReceiveHandoff?: boolean }>;
      }>("/api/v1/handoff-targets/queues").catch(() => ({ queues: [] })),
    ]);
    assignees.value = assigneeResult.users;
    transferQueues.value = (queueResult.queues ?? []).filter(
      (queue) => queue.canReceiveHandoff !== false,
    );
  } catch {
    // 目标列表失败时保持旧客服列表
  }
}

async function doTransfer() {
  if (!selectedId.value || !transferTarget.value) return;
  if (!transferReason.value.trim()) {
    detailError.value = "请填写转交原因";
    return;
  }
  transferOpen.value = false;
  actionBusy.value = true;
  try {
    await api(
      `/api/v1/conversations/${encodeURIComponent(selectedId.value)}/handoff/transfer`,
      {
        method: "POST",
        body: JSON.stringify({
          targetType: transferTargetType.value,
          targetId: transferTarget.value,
          transferReason: transferReason.value.trim(),
          sourceConversationRevision: conversationRevision.value,
          expectedHandoffRevision: handoff.value?.state?.handoffRevision ?? 0,
          clientRequestId: crypto.randomUUID(),
        }),
      },
    );
    transferTarget.value = "";
    transferReason.value = "";
    await select(selectedId.value);
  } catch (reason) {
    detailError.value = reason instanceof Error ? reason.message : "转交失败";
  } finally {
    actionBusy.value = false;
  }
}

async function rejectIncomingTransfer() {
  if (!selectedId.value) return;
  if (!await confirmDialog("拒绝这次转交？会话将保持当前处理状态。")) return;
  actionBusy.value = true;
  try {
    await api(
      `/api/v1/conversations/${encodeURIComponent(selectedId.value)}/handoff/reject-transfer`,
      {
        method: "POST",
        body: JSON.stringify({
          expectedHandoffRevision: handoff.value?.state?.handoffRevision ?? 0,
          clientRequestId: crypto.randomUUID(),
        }),
      },
    );
    await select(selectedId.value);
  } catch (reason) {
    detailError.value = reason instanceof Error ? reason.message : "拒绝失败";
  } finally {
    actionBusy.value = false;
  }
}
// 发送恢复：failed → 重试（幂等复用 clientRequestId）；
// unknown → 自动查询一次 outcome，仍未知才显示「查询结果」，期间禁止重发。
const clientRequestMap = ref<Record<string, string>>({});
const outcomeChecked = ref<Set<string>>(new Set());
const outcomeBusy = ref(false);

async function postMessage(text: string, clientRequestId: string, extra?: {
  mediaId?: string;
  media?: { fileId: string; kind: string };
  assetId?: string;
  replyToChannelMessageId?: string;
  mentionContactRefs?: string[];
}) {
  if (!selectedId.value) return;
  const body: Record<string, any> = { text, clientRequestId };
  if (extra?.mediaId) body.mediaId = extra.mediaId;
  if (extra?.media) body.media = extra.media;
  if (extra?.assetId) body.assetId = extra.assetId;
  if (extra?.replyToChannelMessageId) body.replyToChannelMessageId = extra.replyToChannelMessageId;
  if (extra?.mentionContactRefs?.length) body.mentionContactRefs = extra.mentionContactRefs;
  await api(
    `/api/v1/conversations/${encodeURIComponent(selectedId.value)}/messages`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

async function send() {
  if (!canReply.value || !selectedId.value || sending.value) return;
  sending.value = true;
  const text = replyText.value.trim();
  try {
    const mentionRefs = extractMentionRefs();
    await postMessage(text, crypto.randomUUID(), {
      replyToChannelMessageId: replyTarget.value?.messageId || undefined,
      mentionContactRefs: mentionRefs.length ? mentionRefs : undefined,
    });
    replyText.value = "";
    clearReplyTarget();
    await Promise.all([select(selectedId.value), loadList()]);
  } catch (reason) {
    detailError.value =
      reason instanceof Error ? reason.message : "回复未能发送";
  } finally {
    sending.value = false;
  }
}

async function retryMessage(message: Message) {
  if (!selectedId.value || retryBusy.value) return;
  retryBusy.value = true;
  try {
    const clientRequestId =
      clientRequestMap.value[message.messageId] ?? crypto.randomUUID();
    clientRequestMap.value[message.messageId] = clientRequestId;
    await postMessage(message.text || "", clientRequestId);
    await Promise.all([select(selectedId.value), loadList()]);
  } catch (reason) {
    detailError.value =
      reason instanceof Error ? reason.message : "重试失败";
  } finally {
    retryBusy.value = false;
  }
}

async function checkMessageOutcome(message: Message) {
  if (!selectedId.value) return;
  outcomeBusy.value = true;
  try {
    const clientRequestId =
      clientRequestMap.value[message.messageId] ?? message.messageId;
    const result = await api<{
      status: "pending" | "accepted" | "sent" | "failed" | "not_found";
    }>(
      `/api/v1/conversations/${encodeURIComponent(selectedId.value)}/messages/outcome?clientRequestId=${encodeURIComponent(clientRequestId)}`,
    );
    outcomeChecked.value.add(message.messageId);
    if (result.status !== "not_found") {
      // 服务端已确认状态：刷新会话让 sendState 反映事实
      await select(selectedId.value);
    }
  } catch {
    outcomeChecked.value.add(message.messageId);
  } finally {
    outcomeBusy.value = false;
  }
}

// 会话加载后：对 unknown 消息自动查询一次结果（不把责任丢给用户）
// 加载更早消息：cursor 分页 + scroll anchoring（当前可见消息位置不变）。
async function loadOlderMessages() {
  if (!selectedId.value || !nextCursor.value || loadingOlder.value) return;
  loadingOlder.value = true;
  const pane = messagePane.value;
  const anchorId = pane ? firstVisibleMessageId(pane) : null;
  const anchorTop = pane?.scrollTop ?? 0;
  try {
    const result = await api<{
      messages: Message[];
      nextCursor?: string | null;
    }>(
      `/api/v1/conversations/${encodeURIComponent(selectedId.value)}/messages?limit=100&before=${encodeURIComponent(nextCursor.value)}`,
    );
    const older = result.messages ?? [];
    nextCursor.value = result.nextCursor ?? null;
    if (older.length) {
      messages.value = [...older, ...messages.value];
      await nextTick();
      restoreAnchor(pane, anchorId, anchorTop);
    }
  } catch (reason) {
    detailError.value =
      reason instanceof Error ? reason.message : "加载更早消息失败";
  } finally {
    loadingOlder.value = false;
  }
}

function firstVisibleMessageId(pane: HTMLElement): string | null {
  const rows = pane.querySelectorAll<HTMLElement>("[id^='message-']");
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    if (rect.bottom >= paneRect.top && rect.top <= paneRect.bottom) {
      return row.id.replace(/^message-/, "");
    }
  }
  return null;
}

function restoreAnchor(
  pane: HTMLElement | null,
  anchorId: string | null,
  anchorTop: number,
) {
  if (!pane || !anchorId) {
    pane?.scrollTo({ top: 0 });
    return;
  }
  const el = document.getElementById(`message-${anchorId}`);
  if (el) {
    // 保持锚点消息在视口中的相对位置（prepend 后 offsetTop 变大）
    const relative = anchorTop - el.offsetTop;
    pane.scrollTop = el.offsetTop + relative;
  } else {
    pane.scrollTo({ top: 0 });
  }
}

async function autoCheckUnknownOutcomes() {
  if (!selectedId.value) return;
  for (const message of messages.value) {
    if (
      message.sendState === "unknown" &&
      !outcomeChecked.value.has(message.messageId)
    ) {
      outcomeChecked.value.add(message.messageId);
      const clientRequestId =
        clientRequestMap.value[message.messageId] ?? message.messageId;
      try {
        const result = await api<{ status: string }>(
          `/api/v1/conversations/${encodeURIComponent(selectedId.value)}/messages/outcome?clientRequestId=${encodeURIComponent(clientRequestId)}`,
        );
        if (result.status !== "not_found") {
          await select(selectedId.value);
          break;
        }
      } catch {
        // 查询失败保持 unknown，用户可手动查询
      }
    }
  }
}
async function saveProfile() {
  if (!selectedId.value || !profile.value) return;
  try {
    const result = await api<any>(
      `/api/v1/conversations/${encodeURIComponent(selectedId.value)}/contact-profile`,
      {
        method: "PATCH",
        body: JSON.stringify({
          note: note.value || null,
          tags: tags.value
            .split(/[、,，]/)
            .map((value) => value.trim())
            .filter(Boolean),
          agentEnabled: profile.value.agentEnabled,
        }),
      },
    );
    profile.value = result.profile;
    settingsOpen.value = false;
  } catch (reason) {
    detailError.value =
      reason instanceof Error ? reason.message : "资料保存失败";
  }
}

watch(
  () => route.query.id,
  (id) => {
    if (typeof id === "string" && id !== selectedId.value)
      void select(id, false);
  },
);
function rememberScroll() {
  workspace.scrollTop = messagePane.value?.scrollTop ?? 0;
}

// 滚到最新消息：瞬时滚动 + rAF/延时二次校正。
// 气泡内头像、图片是异步加载的，落地后会改变 scrollHeight；
// 若用 smooth 动画，中途布局变化会直接打断动画，导致停在半路。
function scrollToLatest(guard?: () => boolean) {
  const go = () => {
    const pane = messagePane.value;
    if (pane && (!guard || guard())) pane.scrollTo({ top: pane.scrollHeight });
  };
  go();
  requestAnimationFrame(go);
  window.setTimeout(go, 150);
}

// 新消息跟随：距底 ≤72px 视为“在底部”自动刷新；离开底部时累计未读，点按钮回底。
const atBottom = ref(true);
const newMessageCount = ref(0);
const latestKnownMessageId = ref("");

function onMessagesScroll() {
  const pane = messagePane.value;
  if (!pane) return;
  atBottom.value =
    pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 72;
  workspace.scrollTop = pane.scrollTop;
}

// 后台增量刷新：新消息只 append 到 Transcript，绝不重载整个会话。
// 不进入 Skeleton、不重置 Inspector、不清 Draft、不重挂载图片。
async function refreshTranscriptIncrementally() {
  if (!selectedId.value || loadingConversation.value) return;
  const conversationId = selectedId.value;
  try {
    const result = await api<{
      messages: Message[];
      conversationRevision?: number;
    }>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages?limit=50`,
    );
    // 响应期间切了会话 → 丢弃（避免旧会话数据覆盖新会话）。
    if (selectedId.value !== conversationId) return;
    const fresh = (result.messages ?? []).filter(
      (item) => !messages.value.some((known) => known.messageId === item.messageId),
    );
    if (result.conversationRevision !== undefined)
      conversationRevision.value = result.conversationRevision;
    const newestId = result.messages?.[0]?.messageId ?? "";
    if (newestId) latestKnownMessageId.value = newestId;
    if (!fresh.length) return;
    if (atBottom.value) {
      messages.value = [...messages.value, ...fresh];
      await nextTick();
      scrollToLatest(() => selectedId.value === conversationId);
      // 静默刷新 handoff/依据/联系人（不显示任何 loading）
      void refreshContextSilently();
    } else {
      newMessageCount.value += fresh.length;
    }
  } catch {
    // 后台刷新失败静默；下一轮重试，会话本身不受影响。
  }
}

// ---------- 建议回复已下线 ----------
// 平台决定：Core 的建议回复接口保留，工作台不再提供任何建议回复 UI
// （生成/采纳/过期判定的相关逻辑与界面均已整体移除）。

// 后台静默上下文刷新：只替换数据，不触碰 loading / Inspector / Draft。
async function refreshContextSilently() {
  if (!selectedId.value) return;
  const conversationId = selectedId.value;
  const [handoffResult, evidenceResult] = await Promise.all([
    api<any>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff`,
    ).catch((reason: any) =>
      reason.status === 404 ? null : Promise.reject(reason),
    ),
    api<any>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/knowledge/evidence-tray`,
    ).catch(() => ({ evidence: [] })),
  ]);
  if (selectedId.value !== conversationId) return;
  const next = handoffResult?.handoff ?? null;
  if (next?.state?.status) {
    next.state.status =
      normalizeHandoffStatus(next.state.status) ?? next.state.status;
  }
  handoff.value = next;
  const tray = evidenceResult?.evidence;
  if (Array.isArray(tray)) evidence.value = tray;
}

async function jumpToLatest() {
  const hadNew = newMessageCount.value > 0;
  newMessageCount.value = 0;
  if (hadNew) {
    await select(selectedId.value);
  } else {
    scrollToLatest();
  }
}
function openEvidence(item: Evidence) {
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
// ⌘/Ctrl + Shift + H：eligible 时主动接管当前 Agent 会话（快捷入口，非主要发现路径）
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

onUnmounted(() => {
  stopLivePolling();
});
onMounted(async () => {
  await Promise.all([
    loadList(true),
    api<any>("/api/v1/handoff-assignees")
      .then((result) => {
        assignees.value = result.users;
      })
      .catch(() => undefined),
    api<{ capabilities: Record<string, boolean> }>(
      "/api/v1/console/capabilities",
    )
      .then((result) => {
        capabilities.value = result.capabilities;
        // capability 到达后立即切换到三区形态
        void loadList();
      })
      .catch(() => {
        capabilities.value = {};
      }),
  ]);
  connectRealtime();
  // 页面回到前台立即刷新一次；后台标签页不做额外轮询。
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("keydown", onTakeoverShortcut);
});

// ---------- Realtime（SSE）与降级轮询 ----------
// Core 提供 GET /api/v1/console/events/stream 事件流；事件只触发
// 「失效 → 回拉权威状态 → 增量 patch」。Realtime 健康时 60s 对账，
// 断开时回退 5s 轮询（safety net），重新连上后恢复对账频率。
type RealtimeEvent = {
  type: string;
  conversationId: string;
  occurredAt: string;
  messageId?: string;
};
const REALTIME_EVENT_TYPES = [
  "customer_message",
  "agent_message",
  "human_message",
  "handoff_created",
  "handoff_claimed",
  "handoff_transferred",
  "handoff_finished",
  "ownership_changed",
  "brief_updated",
  "conversation_updated",
] as const;

let eventSource: EventSource | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | undefined;
let reconcileTimer: ReturnType<typeof setInterval> | undefined;
const realtimeConnected = ref(false);

function refreshFromServer() {
  void loadList();
  void refreshTranscriptIncrementally();
}
function scheduleReconcile() {
  clearInterval(fallbackTimer);
  clearInterval(reconcileTimer);
  // Realtime 健康：60s 对账一次，事件驱动增量更新为主。
  reconcileTimer = setInterval(refreshFromServer, 60_000);
}
function scheduleFallback() {
  clearInterval(reconcileTimer);
  if (!fallbackTimer) fallbackTimer = setInterval(refreshFromServer, 5_000);
}
function connectRealtime() {
  if (eventSource) return;
  eventSource = new EventSource("/api/v1/console/events/stream");
  eventSource.onopen = () => {
    realtimeConnected.value = true;
    scheduleReconcile();
  };
  eventSource.onerror = () => {
    // EventSource 自动重连；断开期间用 5s 轮询兜底。
    realtimeConnected.value = false;
    scheduleFallback();
  };
  for (const type of REALTIME_EVENT_TYPES) {
    eventSource.addEventListener(type, (event) => {
      handleRealtimeEvent(type, event);
    });
  }
}
function handleRealtimeEvent(type: string, raw: MessageEvent) {
  let data: RealtimeEvent;
  try {
    data = JSON.parse(String(raw.data));
  } catch {
    return;
  }
  if (data.conversationId === selectedId.value) {
    // 只失效相关资源：消息事件增量补 Transcript，handoff 事件静默刷上下文。
    void refreshTranscriptIncrementally();
    if (type.startsWith("handoff") || type === "ownership_changed")
      void refreshContextSilently();
  }
  void loadList();
}

function onVisibilityChange() {
  if (document.visibilityState === "visible") refreshFromServer();
}
onUnmounted(() => {
  rememberScroll();
  clearInterval(fallbackTimer);
  clearInterval(reconcileTimer);
  eventSource?.close();
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("keydown", onTakeoverShortcut);
});

// ---------- 输入栏：表情 / 图片 / 文件 / 素材（逻辑保留在组合层） ----------
const toolHint = ref("");
let toolHintTimer: ReturnType<typeof setTimeout> | undefined;
function showToolHint(msg: string) {
  toolHint.value = msg;
  if (toolHintTimer) clearTimeout(toolHintTimer);
  toolHintTimer = setTimeout(() => (toolHint.value = ""), 2400);
}
// --- 媒体上传 ---
const mediaUploading = ref(false);
async function uploadMedia(file: File, kind: "image" | "file"): Promise<{ mediaId: string; fileId: string } | null> {
  if (!selectedId.value) return null;
  mediaUploading.value = true;
  try {
    const fd = new FormData();
    fd.append("file", file);
    const result = await api<{ media: { mediaId: string; fileId: string } }>("/api/v1/media", {
      method: "POST",
      body: fd,
    });
    return result.media;
  } catch (reason) {
    showToolHint(reason instanceof Error ? reason.message : "上传失败");
    return null;
  } finally {
    mediaUploading.value = false;
  }
}
// --- 图片/文件选择事件代理：Composer 只发信号，事件对象在组合层组装 ---
let pendingPickKind: "image" | "file" = "image";
function onImagePickerProxy() {
  pendingPickKind = "image";
  nextTick(() => {
    const inputs = document.querySelectorAll<HTMLInputElement>(
      "input[type=file][accept=image/*]",
    );
    const input = inputs[inputs.length - 1];
    input?.click();
  });
}
function onFilePickerProxy() {
  pendingPickKind = "file";
  nextTick(() => {
    const inputs = document.querySelectorAll<HTMLInputElement>(
      "input[type=file]:not([accept=image/*])",
    );
    const input = inputs[inputs.length - 1];
    input?.click();
  });
}
async function onImagePicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const result = await uploadMedia(file, "image");
  if (!result) return;
  try {
    await postMessage("", crypto.randomUUID(), {
      mediaId: result.mediaId,
      media: { fileId: result.fileId, kind: "image" },
    });
    await Promise.all([select(selectedId.value), loadList()]);
  } catch {
    showToolHint("图片发送失败");
  }
}
// --- 文件选择 & 发送 ---
async function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const result = await uploadMedia(file, "file");
  if (!result) return;
  try {
    await postMessage("", crypto.randomUUID(), {
      mediaId: result.mediaId,
      media: { fileId: result.fileId, kind: "file" },
    });
    await Promise.all([select(selectedId.value), loadList()]);
  } catch {
    showToolHint("文件发送失败");
  }
}
// --- 素材选择器（本机文件 / 图片空间 / 文件空间） ---
const assetPickerOpen = ref(false);
async function sendAsset(asset: AssetItem, text = "") {
  if (!selectedId.value) return;
  mediaUploading.value = true;
  try {
    await postMessage(text, crypto.randomUUID(), { assetId: asset.assetId });
    await Promise.all([select(selectedId.value), loadList()]);
  } catch (reason) {
    showToolHint(reason instanceof Error ? reason.message : "素材发送失败");
  } finally {
    mediaUploading.value = false;
  }
}
async function onAssetPicked(result: AssetPickResult) {
  assetPickerOpen.value = false;
  if (!selectedId.value) return;
  try {
    if (result.type === "asset") {
      await sendAsset(result.asset);
    } else {
      // 降级路径：入空间失败时直接按原有上传发送链路发送
      const uploaded = await uploadMedia(result.file, result.category);
      if (!uploaded) return;
      await postMessage("", crypto.randomUUID(), {
        mediaId: uploaded.mediaId,
        media: { fileId: uploaded.fileId, kind: result.category },
      });
      await Promise.all([select(selectedId.value), loadList()]);
    }
  } catch (reason) {
    showToolHint(reason instanceof Error ? reason.message : "发送失败");
  }
}
// 管理员可在选择器中整理（重命名/删除）
const canManageAssets = computed(() => auth.isAdmin);

// --- 引用回复 ---
const replyTarget = ref<Message | null>(null);
function setReplyTarget(message: Message) {
  replyTarget.value = message;
}
function clearReplyTarget() {
  replyTarget.value = null;
}
// --- 拍一拍 ---
async function sendPoke(_message: Message) {
  if (!selectedId.value) return;
  try {
    await api(`/api/v1/conversations/${encodeURIComponent(selectedId.value)}/poke`, {
      method: "POST",
    });
    await Promise.all([select(selectedId.value), loadList()]);
  } catch {
    showToolHint("拍一拍发送失败");
  }
}
// --- @提及 ---
const mentionContacts = computed(() => {
  const sources: Array<{ id: string; name: string }> = [];
  // 从联系人 profile
  if (profile.value?.contactId) {
    sources.push({ id: profile.value.contactId, name: contactDisplayName(selected.value) || "联系人" });
  }
  // 从 assignees（客服列表）
  for (const u of assignees.value) {
    sources.push({ id: u.userId, name: u.displayName || u.username || u.userId });
  }
  return sources;
});
/** 从当前 replyText 中提取 mentionContactRefs（@名字列表） */
function extractMentionRefs(): string[] {
  const text = replyText.value;
  const refs: string[] = [];
  const regex = /@(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const name = m[1];
    // 尝试匹配联系人或客服名
    const found = mentionContacts.value.find((c) => c.name === name);
    if (found) refs.push(found.id);
  }
  return refs;
}
// --- 消息右键菜单（按目标拆分）：气泡=回复，头像=拍一拍 ---
const messageMenu = ref<{
  x: number;
  y: number;
  message: Message;
  kind: "bubble" | "avatar";
} | null>(null);
function openMessageMenu(
  event: MouseEvent,
  message: Message,
  kind: "bubble" | "avatar" = "bubble",
) {
  event.preventDefault();
  messageMenu.value = { x: event.clientX, y: event.clientY, message, kind };
}
function closeMessageMenu() {
  messageMenu.value = null;
}
function handleMenuReply(message: Message) {
  setReplyTarget(message);
  closeMessageMenu();
}
function handleMenuPoke(message: Message) {
  sendPoke(message);
  closeMessageMenu();
}

// --- Composer 派生文案 ---
const composerPlaceholder = computed(() => {
  if (handoff.value?.state?.status === "pending") return "先领取会话，再回复客户";
  if (handoff.value?.state?.status === "in_progress" && !mine.value) return "其他客服正在处理";
  return "输入回复…";
});
const composerDisabled = computed(
  () => handoff.value?.state?.status === "in_progress" && !mine.value,
);
const transferPendingLabel = computed(() => {
  if (handoff.value?.state?.status !== "transfer_pending") return null;
  return handoff.value.state.targetQueueId
    ? `已进入队列${handoff.value.state.targetDisplayName ? `（${handoff.value.state.targetDisplayName}）` : ""}，等待成员接手`
    : `等待 ${handoff.value.state.targetDisplayName || "目标客服"} 接受`;
});
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
        :composer-placeholder="composerPlaceholder"
        :composer-disabled="composerDisabled"
        :retry-busy="retryBusy"
        :outcome-busy="outcomeBusy"
        @open-customer="openInspector('customer')"
        @open-settings="settingsOpen = true"
        @open-transfer="openTransfer()"
        @open-profile="router.push('/profile')"
        @takeover="transition('take-over')"
        @resolve="transition('resolve')"
        @reject-transfer="rejectIncomingTransfer"
        @reload-detail="select(selectedId)"
        @load-older="loadOlderMessages"
        @jump-latest="jumpToLatest"
        @scroll="onMessagesScroll"
        @send="send"
        @pick-image="() => onImagePickerProxy()"
        @pick-file="() => onFilePickerProxy()"
        @open-assets="assetPickerOpen = true"
        @clear-reply="clearReplyTarget"
        @message-contextmenu="(event, m) => openMessageMenu(event, m, 'bubble')"
        @avatar-contextmenu="(event, m) => openMessageMenu(event, m, 'avatar')"
        @retry-message="retryMessage"
        @check-outcome="checkMessageOutcome"
        @open-trace="openSessionTrace"
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
