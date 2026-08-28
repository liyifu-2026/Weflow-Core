<script setup lang="ts">
import { confirmDialog } from "../components/confirm-dialog";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { useWeflowAuthStore } from "../auth-store";
import WfIcon from "../components/WfIcon.vue";
import MediaImage from "../components/MediaImage.vue";
import AvatarImage from "../components/AvatarImage.vue";
import StaffAvatar from "../components/StaffAvatar.vue";
import VoiceMessage from "../components/VoiceMessage.vue";
import WfInspector from "../components/WfInspector.vue";
import { statusTone } from "../components/status-tone";
import { useEscClose } from "../composables/use-esc-close";
import { agentDisplayName, contactDisplayName, factLabel, reasonLabel } from "../labels";
import { knowledgeTarget } from "../navigation-context";
import { useConversationWorkspaceStore } from "../stores/conversation-workspace";

type Conversation = {
  conversationId: string;
  latestMessageAt?: string;
  latestMessage?: { text?: string };
  matchedMessage?: { text?: string; occurredAt?: string };
  contact?: Record<string, any>;
  handoff?: {
    status?: string;
    assignedUserId?: string;
    assignedUser?: { username?: string };
    reason?: string;
    createdAt?: string;
    agentPaused?: boolean;
  } | null;
  unreadCustomerCount?: number;
  riskLevel?: string | null;
  permissions?: ConversationPermissions;
};
/** 会话级操作权限（Core 计算；capability 开启后缺失即只读，客户端不猜） */
type ConversationPermissions = {
  canView: boolean;
  canManualTakeover: boolean;
  canReply: boolean;
  canTransfer: boolean;
  canFinish: boolean;
};
type Message = {
  messageId: string;
  actorType: string;
  direction: string;
  text?: string;
  contentType?: string;
  mediaId?: string;
  sendState?: string;
  occurredAt: string;
  actorId?: string;
  /** AI 员工头像（平台 DiceBear 代理 URL）；人工/客户消息为 null */
  actorAvatarUrl?: string | null;
  replyToChannelMessageId?: string;
  mentionContactRefs?: string[];
};
type Evidence = {
  evidenceId?: string;
  chunkId?: string;
  documentId?: string;
  knowledgeBaseId?: string;
  title?: string;
  sourceName?: string;
  excerpt?: string;
  provenance?: "human_selected" | "agent_retrieval";
  sourceExecutionId?: string;
};

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
type SectionScope = "attention" | "mine" | "others";
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
const queueSearchOpen = ref(false);
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
  inspectorOpen.value = true;
  if (view === "history") void loadHistory();
}
function closeInspector() {
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
      return historySelectedId.value ? "历史对话" : "历史对话";
  }
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


function priority(item: Conversation) {
  const risk =
    item.riskLevel === "high" ? 300 : item.riskLevel === "medium" ? 150 : 0;
  const handoffRank =
    item.handoff?.status === "pending"
      ? 200
      : item.handoff?.status === "in_progress"
        ? 100
        : 0;
  return risk + handoffRank + Number(item.unreadCustomerCount || 0);
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
function riskLabel(risk?: string | null) {
  return risk === "high" ? "高风险" : risk === "medium" ? "需关注" : "常规";
}
function actorLabel(message: Message) {
  return message.actorType === "agent"
    ? "Agent"
    : message.direction === "outbound"
      ? "人工客服"
      : "客户";
}
// 气泡 meta 降噪：客户只显示时间；Agent 显示身份；人工显示本人用户名
// （历史他人消息显示「其他客服」，不伪造名字）。
function bubbleMetaLabel(message: Message): string {
  if (message.actorType === "agent") return "Agent";
  if (message.direction === "inbound") return "";
  return message.actorId === auth.user?.userId
    ? (auth.user?.username ?? "我")
    : "其他客服";
}
// ---------- 微信客户端式消息渲染 ----------
// 表情包：不渲染图片截图，直接显示纯文本「[表情包]<含义>」。
function isEmotionMessage(message: Message): boolean {
  return message.contentType === "emotion";
}
function emotionLabel(message: Message): string {
  const meaning = (message.text || "").trim();
  return meaning ? `[表情包]${meaning}` : "[表情包]";
}
/** 表情包贴纸：emotion 类型，或带「[表情包]」文本的图片消息（有媒体） */
function isEmotionSticker(message: Message): boolean {
  return (
    (message.contentType === "emotion" ||
      (message.contentType === "image" &&
        (message.text || "").includes("[表情包]"))) &&
    Boolean(message.mediaId)
  );
}
// 拍一拍：系统样式提示条，显示「对方拍了拍你」。
function isPatMessage(message: Message): boolean {
  return (
    message.contentType === "pat" ||
    (message.actorType === "system" && /拍了拍/.test(message.text || ""))
  );
}
/** 气泡正文：表情包走文本含义；其余按原逻辑。 */
function bubbleText(message: Message): string {
  if (isEmotionMessage(message)) return emotionLabel(message);
  return message.text || "〔非文本消息〕";
}

// ---------- 引用回复 & @提及渲染 ----------
/** 在当前消息列表中找到被引用的原消息 */
function quotedMessage(message: Message): Message | undefined {
  if (!message.replyToChannelMessageId) return undefined;
  return messages.value.find(
    (m) => m.messageId === message.replyToChannelMessageId,
  );
}
/** 引用卡片摘要：取原消息前 40 字符 */
function quotedSummary(quoted: Message): string {
  const text = (quoted.text || "").trim();
  if (!text) return "〔非文本消息〕";
  return text.length > 40 ? text.slice(0, 40) + "…" : text;
}
/** 将消息文本中的 @提及 渲染为高亮 span 段。
 *  返回交替的 { text, isMention } 段列表，供 v-for 渲染。 */
function mentionSegments(text: string): Array<{ text: string; mention: boolean }> {
  if (!text) return [];
  const segments: Array<{ text: string; mention: boolean }> = [];
  const regex = /@\S+/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), mention: false });
    }
    segments.push({ text: match[0], mention: true });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), mention: false });
  }
  return segments;
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
type QueueSectionKey = "attention" | "mine" | "others";
const queueSections = computed<Array<{ key: QueueSectionKey; title: string; tone: string; items: Conversation[] }>>(() => {
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

// 白名单会话（agentEnabled=true）：AI 托管；非白名单（false）由人工处理。
// 工作区视图在 Core 端已按 agentEnabled=true 过滤（带 ?agentEnabled=true），
// 这里保留 client filter 作为 capability 未开启时的兜底。
const whitelistConversations = computed<Conversation[]>(() =>
  flatConversations.value.filter((item) => item.contact?.agentEnabled === true),
);
const nonWhitelistConversations = computed<Conversation[]>(() =>
  flatConversations.value.filter((item) => item.contact?.agentEnabled !== true),
);
// 顶层页面：workspace=三区工作区（仅白名单客户）；contacts=联系人（全部，只读）
type PageMode = "workspace" | "contacts";
const pageMode = ref<PageMode>("workspace");
// 联系人页：本地状态（独立分页/搜索，与工作区互不干扰）
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
const contactSearchInput = ref("");
const contactSearchApplied = ref("");
function rowSummary(item: Conversation): string {
  const text =
    item.latestMessage?.text || item.matchedMessage?.text || "";
  return text.trim() || "暂无消息";
}
function rowTimeLabel(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}
// ---------- 输入栏：表情 / 图片 / 文件 ----------
const EMOJI_CHOICES = [
  "😀","😁","😂","🤣","😅","😊","😍","😘",
  "😜","🤗","🤔","😴","😭","😤","😡","🥺",
  "👍","👏","🙏","💪","🤝","👌","✌️","👋",
  "❤️","💔","🎉","🎂","🌹","⚡","☀️","🌙",
];
const emojiPickerOpen = ref(false);
function toggleEmojiPicker() {
  emojiPickerOpen.value = !emojiPickerOpen.value;
}
function insertEmoji(emoji: string) {
  replyText.value = `${replyText.value}${emoji}`;
}
function closeEmojiPicker() {
  emojiPickerOpen.value = false;
}
// 图片/文件：真实上传逻辑
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
// --- 图片选择 & 发送 ---
const imageInputRef = ref<HTMLInputElement | null>(null);
function triggerImagePick() {
  imageInputRef.value?.click();
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
const fileInputRef = ref<HTMLInputElement | null>(null);
function triggerFilePick() {
  fileInputRef.value?.click();
}
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
// --- 引用回复 ---
const replyTarget = ref<Message | null>(null);
function setReplyTarget(message: Message) {
  replyTarget.value = message;
}
function clearReplyTarget() {
  replyTarget.value = null;
}
// --- 拍一拍 ---
async function sendPoke(message: Message) {
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
const mentionOpen = ref(false);
const mentionFilter = ref("");
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
  const q = mentionFilter.value.toLowerCase();
  if (!q) return sources;
  return sources.filter((c) => c.name.toLowerCase().includes(q));
});
function onReplyInput(event: Event) {
  const textarea = event.target as HTMLTextAreaElement;
  const val = textarea.value;
  const cursorPos = textarea.selectionStart ?? 0;
  // 向前查找最近的 @ 符号
  const before = val.slice(0, cursorPos);
  const atIdx = before.lastIndexOf("@");
  if (atIdx === -1 || (atIdx > 0 && before[atIdx - 1] !== " " && before[atIdx - 1] !== "\n")) {
    mentionOpen.value = false;
    return;
  }
  const query = before.slice(atIdx + 1);
  // 如果 @ 后面已有空格，说明提及已结束
  if (/\s/.test(query)) {
    mentionOpen.value = false;
    return;
  }
  mentionFilter.value = query;
  mentionOpen.value = true;
}
function selectMentionContact(contact: { id: string; name: string }) {
  const textarea = document.querySelector(".wx-input") as HTMLTextAreaElement | null;
  if (!textarea) return;
  const val = textarea.value;
  const cursorPos = textarea.selectionStart ?? val.length;
  const before = val.slice(0, cursorPos);
  const atIdx = before.lastIndexOf("@");
  if (atIdx === -1) return;
  const after = val.slice(cursorPos);
  replyText.value = `${val.slice(0, atIdx)}@${contact.name} ${after}`;
  mentionOpen.value = false;
  nextTick(() => {
    const newPos = atIdx + contact.name.length + 2; // @name + space
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();
  });
}
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
// --- 消息右键菜单 ---
const messageMenu = ref<{ x: number; y: number; message: Message } | null>(null);
function openMessageMenu(event: MouseEvent, message: Message) {
  event.preventDefault();
  messageMenu.value = { x: event.clientX, y: event.clientY, message };
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
// 状态降噪：正常（sent/confirmed）不显示；仅发送中/失败/未知显示。
function isNonDefaultSendState(message: Message): boolean {
  return ["sending", "pending", "failed", "unknown"].includes(
    message.sendState || "",
  );
}
function messageTime(value: string) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
function ownershipLabel() {
  const state = handoff.value?.state;
  if (!state) return "Agent 处理中";
  if (state.status === "pending") return "等待接手";
  if (state.status === "in_progress")
    return mine.value ? "我处理中" : "其他客服处理中";
  if (state.status === "resolved") return "已完成";
  return handoffLabel(state.status);
}
function cycleStatusLabel(status?: string) {
  const map: Record<string, string> = {
    HANDOFF_PENDING: "等待处理",
    HANDOFF_ACCEPTED: "已接管",
    HANDOFF_RESOLVED: "已结束",
    TRANSFER_PENDING: "转交等待接受",
    TRANSFERRED: "已转交",
    AGENT_HANDOFF: "Agent 转人工",
  };
  return map[String(status).toUpperCase()] ?? status ?? "交接";
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
    const firstInSections =
      sectionAttention.value[0] ??
      sectionMine.value[0] ??
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
function contactItemDisplayName(item: ContactSummary): string {
  return (
    item.sharedAlias ||
    item.channelRemark ||
    item.channelNickname ||
    item.channelDisplayName ||
    item.contactId
  );
}
async function loadContacts(append = false) {
  if (pageMode.value !== "contacts") return;
  if (append ? contactsLoadingMore.value : contactsLoading.value) return;
  if (append) contactsLoadingMore.value = true;
  else contactsLoading.value = true;
  contactsError.value = "";
  try {
    const cursor = append ? contactsNextCursor.value : null;
    const query = new URLSearchParams();
    query.set("limit", "50");
    if (contactSearchApplied.value)
      query.set("q", contactSearchApplied.value);
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
function applyContactSearch() {
  contactSearchApplied.value = contactSearchInput.value.trim();
  void loadContacts();
}
function clearContactSearch() {
  contactSearchInput.value = "";
  contactSearchApplied.value = "";
  void loadContacts();
}
// 切到联系人页时按需加载；切回工作区不重复请求。
watch(pageMode, (next) => {
  if (next === "contacts" && !contacts.value.length && !contactsLoading.value) {
    void loadContacts();
  }
});
// 联系人页点击联系人：切换到工作区并选中对应会话
function selectContactAndSwitch(conversationId: string) {
  pageMode.value = "workspace";
  void select(conversationId);
}

async function select(id: string, syncRoute = true) {
  if (!id) return;
  const generation = ++selectionGeneration;
  selectedId.value = id;
  // 不自动展开检查器：浮层模式下 backdrop 会遮挡工作区（回复框），
  // 检查器改为用户主动打开（查看依据/摘要/资料等按钮）
  inspectorView.value = "context";
  transferOpen.value = false;
  settingsOpen.value = false;
  if (syncRoute && route.query.id !== id) {
    await router.replace({ query: { id } });
  }
  loadingConversation.value = true;
  detailError.value = "";
  try {
    const [transcript, handoffResult, profileResult, evidenceResult] =
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

function sendStateLabel(state?: string) {
  if (!state) return "";
  if (state === "confirmed" || state === "sent") return "已发送";
  if (state === "failed") return "发送失败";
  if (state === "unknown") return "结果未知";
  if (state === "pending" || state === "sending") return "发送中";
  if (state === "accepted") return "已受理";
  return state;
}

async function postMessage(text: string, clientRequestId: string, extra?: {
  mediaId?: string;
  media?: { fileId: string; kind: string };
  replyToChannelMessageId?: string;
  mentionContactRefs?: string[];
}) {
  if (!selectedId.value) return;
  const body: Record<string, any> = { text, clientRequestId };
  if (extra?.mediaId) body.mediaId = extra.mediaId;
  if (extra?.media) body.media = extra.media;
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
</script>

<template>
  <div class="wf-service-page">
    <div class="wf-service-head">
      <h1>{{ pageMode === "contacts" ? "联系人" : "客户服务" }}</h1>
      <button
        v-if="pageMode === 'workspace'"
        class="wf-icon-button"
        title="刷新队列"
        @click="loadList()"
      >
        <WfIcon name="refresh" :size="15" />
      </button>
      <button
        v-else
        class="wf-icon-button"
        title="刷新联系人"
        @click="loadContacts()"
      >
        <WfIcon name="refresh" :size="15" />
      </button>
    </div>
    <div class="wf-cs-layout">
      <aside class="wf-queue">
        <div class="wf-queue-head">
          <div class="wf-queue-tools">
            <template v-if="queueSearchOpen">
              <div class="wf-search">
                <WfIcon name="search" :size="16" /><input
                  v-model="search"
                  class="wf-input"
                  placeholder="联系人、消息或会话 ID"
                  autofocus
                  @keyup.enter="loadList()"
                />
              </div>
              <button
                class="wf-icon-button"
                title="收起搜索"
                @click="queueSearchOpen = false"
              >
                ×
              </button>
            </template>
            <button
              v-else
              class="wf-icon-button wf-queue-search-toggle"
              title="搜索会话"
              @click="queueSearchOpen = true"
            >
              <WfIcon name="search" :size="16" />
            </button>
          </div>
        </div>
        <div v-if="listError" class="wf-error wf-pane-error">
          <span>{{ listError }}</span
          ><button class="wf-button compact" @click="loadList()">重试</button>
        </div>
        <!-- 顶层页面切换：工作区 / 联系人 -->
        <div v-if="!listError" class="wf-queue-mode">
          <button
            class="wf-mode-btn"
            :class="{ active: pageMode === 'workspace' }"
            @click="pageMode = 'workspace'"
          >工作区</button
          ><button
            class="wf-mode-btn"
            :class="{ active: pageMode === 'contacts' }"
            @click="pageMode = 'contacts'"
          >联系人</button
          ><router-link
            v-if="auth.isAdmin"
            to="/support/whitelist"
            class="wf-mode-btn wf-mode-link"
            title="白名单配置"
          >白名单</router-link>
        </div>
        <!-- 工作区：三区会话（仅白名单客户） -->
        <template v-if="pageMode === 'workspace'">
          <div v-if="loadingList" class="wf-queue-loading">
            <div v-for="i in 6" :key="i" class="wx-row">
              <div class="wf-skeleton wf-skeleton-title"></div>
              <div class="wf-skeleton wf-skeleton-line"></div>
            </div>
          </div>
          <div v-if="listError" class="wf-error wf-pane-error">
            <span>{{ listError }}</span
            ><button class="wf-button compact" @click="loadList()">重试</button>
          </div>
          <!-- 工作区搜索态：使用旧的单列接口 -->
          <template
            v-if="!loadingList && !listError && search"
          >
            <div
              v-for="item in flatConversations"
              :key="item.conversationId"
              class="wx-row"
              :class="{ active: selectedId === item.conversationId }"
              @click="select(item.conversationId)"
            >
              <AvatarImage
                :contact-id="item.contact?.contactId"
                :fallback-text="contactDisplayName(item)"
                :size="40"
              />
              <div class="wx-row-body">
                <div class="wx-row-top">
                  <span class="wx-row-name">{{
                    contactDisplayName(item)
                  }}</span>
                  <span class="wx-row-time">{{
                    rowTimeLabel(
                      item.latestMessageAt ||
                        item.matchedMessage?.occurredAt,
                    )
                  }}</span>
                </div>
                <div class="wx-row-bottom">
                  <span class="wx-row-preview">{{ rowSummary(item) }}</span>
                </div>
              </div>
            </div>
            <div v-if="!flatConversations.length" class="wf-empty">
              <div>
                <strong>没有符合条件的会话</strong>
                <p>调整搜索词后再试。</p>
              </div>
            </div>
          </template>
          <!-- 三区列表：等待处理（红）/ 我处理的（蓝）/ 其他对话（灰） -->
          <template
            v-else-if="
              !loadingList && !listError && conversationPermissionsEnabled
            "
          >
            <div
              v-for="section in queueSections"
              :key="section.key"
              class="wf-queue-section"
            >
              <div class="wf-queue-section-head" :class="`tone-${section.tone}`">
                <span class="wf-queue-section-title">{{ section.title }}</span>
                <span class="wf-queue-section-count">{{ section.items.length }}</span>
              </div>
              <div
                v-for="item in section.items"
                :key="item.conversationId"
                class="wx-row"
                :class="{ active: selectedId === item.conversationId }"
                @click="select(item.conversationId)"
              >
                <AvatarImage
                  :contact-id="item.contact?.contactId"
                  :fallback-text="contactDisplayName(item)"
                  :size="40"
                />
                <div class="wx-row-body">
                  <div class="wx-row-top">
                    <span class="wx-row-name">{{
                      contactDisplayName(item)
                    }}</span>
                    <span
                      v-if="item.handoff?.status === 'pending' || item.riskLevel === 'high'"
                      class="wx-row-flag"
                      >{{
                        item.handoff?.status === "pending"
                          ? "待接手"
                          : riskLabel(item.riskLevel)
                      }}</span
                    ><span v-else class="wx-row-time">{{
                      rowTimeLabel(
                        item.latestMessageAt || item.matchedMessage?.occurredAt,
                      )
                    }}</span>
                  </div>
                  <div class="wx-row-bottom">
                    <span class="wx-row-preview">{{ rowSummary(item) }}</span>
                    <span
                      v-if="Number(item.unreadCustomerCount || 0) > 0"
                      class="wx-row-unread"
                      >{{
                        Number(item.unreadCustomerCount) > 99
                          ? "99+"
                          : item.unreadCustomerCount
                      }}</span
                    >
                  </div>
                </div>
              </div>
              <div v-if="!section.items.length" class="wf-queue-section-empty">
                <span>暂无</span>
              </div>
            </div>
            <div
              v-if="!queueSections.some((s) => s.items.length)"
              class="wf-empty"
            >
              <div>
                <strong>暂无会话</strong>
                <p>Agent 可以继续自动处理现有会话。</p>
              </div>
            </div>
            <button
              v-if="hasMoreConversations"
              class="wf-load-more"
              :disabled="loadingMoreConversations"
              @click="loadOlderConversations"
            >
              {{ loadingMoreConversations ? "正在加载…" : "加载更多" }}
            </button>
          </template>
          <!-- 兜底：capability 未开启时维持旧单列（不区分白名单）。 -->
          <template v-else-if="!loadingList && !listError">
            <div
              v-for="item in flatConversations"
              :key="item.conversationId"
              class="wx-row"
              :class="{ active: selectedId === item.conversationId }"
              @click="select(item.conversationId)"
            >
              <AvatarImage
                :contact-id="item.contact?.contactId"
                :fallback-text="contactDisplayName(item)"
                :size="40"
              />
              <div class="wx-row-body">
                <div class="wx-row-top">
                  <span class="wx-row-name">{{
                    contactDisplayName(item)
                  }}</span>
                  <span class="wx-row-time">{{
                    rowTimeLabel(
                      item.latestMessageAt ||
                        item.matchedMessage?.occurredAt,
                    )
                  }}</span>
                </div>
                <div class="wx-row-bottom">
                  <span class="wx-row-preview">{{ rowSummary(item) }}</span>
                </div>
              </div>
            </div>
            <div v-if="!flatConversations.length" class="wf-empty">
              <div>
                <strong>暂无会话</strong>
                <p>Agent 可以继续自动处理现有会话。</p>
              </div>
            </div>
          </template>
        </template>
        <!-- 联系人页：全部客户，只读浏览 -->
        <template v-else-if="pageMode === 'contacts'">
          <div class="wf-queue-search">
            <div class="wf-search">
              <WfIcon name="search" :size="16" /><input
                v-model="contactSearchInput"
                class="wf-input"
                placeholder="按昵称、备注或共享别名搜索"
                @keyup.enter="applyContactSearch"
              />
            </div>
            <button
              v-if="contactSearchInput"
              class="wf-icon-button"
              title="清空"
              @click="clearContactSearch"
            >×</button>
            <button
              v-else
              class="wf-icon-button"
              title="搜索"
              @click="applyContactSearch"
            ><WfIcon name="search" :size="16" /></button>
          </div>
          <div v-if="contactsError" class="wf-error wf-pane-error">
            <span>{{ contactsError }}</span
            ><button class="wf-button compact" @click="loadContacts()">
              重试
            </button>
          </div>
          <div
            v-if="contactsLoading && !contacts.length"
            class="wf-queue-loading"
          >
            <div v-for="i in 6" :key="i" class="wx-row">
              <div class="wf-skeleton wf-skeleton-title"></div>
              <div class="wf-skeleton wf-skeleton-line"></div>
            </div>
          </div>
          <div
            v-for="item in contacts"
            v-else
            :key="item.contactId"
            class="wx-row"
            :class="{ active: selectedId === item.conversationId }"
            @click="selectContactAndSwitch(item.conversationId)"
          >
            <AvatarImage
              :contact-id="item.contactId"
              :fallback-text="contactItemDisplayName(item)"
              :size="40"
            />
            <div class="wx-row-body">
              <div class="wx-row-top">
                <span class="wx-row-name">{{
                  contactItemDisplayName(item)
                }}</span>
                <span
                  v-if="item.agentEnabled"
                  class="wx-row-flag"
                  title="Agent 自动回复已开启"
                >白名单</span>
                <span v-else class="wx-row-time">仅人工</span>
              </div>
              <div class="wx-row-bottom">
                <span class="wx-row-preview">{{
                  item.latestMessageText || "暂无消息"
                }}</span>
                <span
                  v-if="item.latestMessageAt"
                  class="wx-row-time"
                >{{ rowTimeLabel(item.latestMessageAt) }}</span>
              </div>
            </div>
          </div>
          <div v-if="!contactsLoading && !contacts.length" class="wf-empty">
            <div>
              <strong>{{
                contactSearchApplied ? "没有符合条件的联系人" : "暂无联系人"
              }}</strong>
              <p v-if="!contactSearchApplied">
                客户首次发消息后将出现在此处。
              </p>
            </div>
          </div>
          <button
            v-if="contactsNextCursor"
            class="wf-load-more"
            :disabled="contactsLoadingMore"
            @click="loadContacts(true)"
          >
            {{ contactsLoadingMore ? "正在加载…" : "加载更多" }}
          </button>
        </template>
      </aside>

      <section class="wf-pane wf-thread">
        <template v-if="selected">
          <div class="wf-thread-head">
            <div class="wf-thread-title">
              <div class="wf-thread-person">
                <AvatarImage
                  :contact-id="selected.contact?.contactId"
                  :fallback-text="contactDisplayName(selected)"
                  :size="32"
                  style="align-self: center"
                />
                <button
                  class="wf-person-button"
                  title="查看客户资料"
                  @click="openInspector('customer')"
                >
                  <strong>{{ contactDisplayName(selected) }}</strong>
                  <span v-if="company" class="wf-thread-company"
                    >· {{ company }}</span
                  >
                </button>
                <span
                  v-if="
                    selected.riskLevel === 'high' ||
                    selected.riskLevel === 'medium'
                  "
                  class="wf-risk-text"
                  :class="selected.riskLevel"
                  >{{ riskLabel(selected.riskLevel) }}</span
                >
              </div>
              <div class="wf-actions">
                <!-- 三条命令语义精确：AGENT_ACTIVE→Manual Takeover；pending→Claim -->
                <button
                  v-if="canManualTakeover"
                  class="wf-button compact primary"
                  :disabled="actionBusy"
                  @click="transition('take-over')"
                >
                  接手处理
                </button>
                <button
                  v-else-if="handoff?.state?.status === 'pending'"
                  class="wf-button compact primary"
                  :disabled="actionBusy"
                  @click="transition('accept')"
                >
                  接手处理
                </button>
                <details class="wf-row-menu">
                  <summary class="wf-icon-button" title="更多操作">···</summary>
                  <div>
                    <button @click="router.push('/support/profile')">
                      个人资料
                    </button>
                    <button v-if="canTransfer" @click="openTransfer()">
                      转交处理
                    </button>
                    <button @click="settingsOpen = true">会话设置</button>
                    <button
                      v-if="canFinish"
                      class="danger"
                      @click="transition('resolve')"
                    >
                      结束人工处理
                    </button>
                  </div>
                </details>
              </div>
            </div>
            <div class="wf-thread-task">{{ briefingLine }}</div>
            <div
              v-if="handoff?.state?.status === 'transfer_pending'"
              class="wf-transfer-status"
            >
              <span>{{
                handoff.state.targetQueueId
                  ? `已进入队列${handoff.state.targetDisplayName ? `（${handoff.state.targetDisplayName}）` : ""}，等待成员接手`
                  : `等待 ${handoff.state.targetDisplayName || "目标客服"} 接受`
              }}</span>
              <button
                v-if="handoff.state.canRejectTransfer"
                class="wf-link wf-link-button"
                :disabled="actionBusy"
                @click="rejectIncomingTransfer"
              >
                拒绝转交
              </button>
            </div>
          </div>
          <div v-if="detailError" class="wf-error wf-thread-error">
            <span>{{ detailError }}</span
            ><button class="wf-button compact" @click="select(selectedId)">
              重新加载
            </button>
          </div>

          <!-- Brief 内容统一在右侧 Inspector（context/brief 视图）展示；thread 保持纯净 -->
          <div ref="messagePane" class="wf-messages" @scroll="onMessagesScroll">
            <button
              v-if="nextCursor && !loadingConversation"
              class="wf-load-older"
              :disabled="loadingOlder"
              @click="loadOlderMessages"
            >
              {{ loadingOlder ? "正在加载…" : "加载更早的消息" }}
            </button>
            <template v-if="loadingConversation"
              ><div
                v-for="i in 4"
                :key="i"
                class="wf-message-row"
                :class="{ outbound: i % 2 === 0 }"
              >
                <div class="wf-skeleton wf-message">正在读取消息内容</div>
              </div></template
            >
            <template v-else>
              <div
                v-for="message in messages"
                :key="message.messageId"
                :id="`message-${message.messageId}`"
                class="wf-message-row"
                :class="{
                  outbound: message.direction === 'outbound',
                  agent: message.actorType === 'agent',
                  'wf-target-highlight':
                    route.query.messageId === message.messageId,
                }"
                @contextmenu="openMessageMenu($event, message)"
              >
                <!-- 拍一拍：居中系统小字（同微信）；其他系统事件沿用方向气泡 -->
                <div
                  v-if="isPatMessage(message)"
                  class="wf-pat-notice"
                >
                  {{ /拍了拍/.test(message.text || "") ? message.text : "对方拍了拍你" }}
                </div>
                <div
                  v-else-if="message.actorType === 'system'"
                  class="wf-bubble-row"
                  :class="[
                    message.direction === 'outbound' ? 'me' : 'them',
                    { system: true },
                  ]"
                >
                  <div class="wf-bubble wf-bubble-system">
                    {{ message.text || "系统事件" }}
                    <span class="wf-bubble-meta">
                      {{ messageTime(message.occurredAt) }}
                    </span>
                  </div>
                </div>
                <template v-else>
                  <!-- 微信式气泡：正文最高视觉权重；meta 降噪（正常状态消失、
                       异常才出现）；操作 hover/focus 按需出现，键盘可达 -->
                  <div
                    class="wf-bubble-row"
                    :class="[
                      message.direction === 'outbound' ? 'me' : 'them',
                      {
                        agent: message.actorType === 'agent',
                        failed: message.sendState === 'failed',
                        unknown: message.sendState === 'unknown',
                      },
                    ]"
                  >
                    <!-- 客户消息（inbound）：左侧显示客户头像 -->
                    <AvatarImage
                      v-if="message.direction === 'inbound' && selected?.contact?.contactId"
                      :contact-id="selected.contact.contactId"
                      :fallback-text="contactDisplayName(selected)"
                      :size="28"
                      class="wf-msg-avatar"
                    />
                    <div class="wf-bubble-wrap">
                      <div
                        class="wf-bubble"
                        :class="{
                          media:
                            message.contentType === 'image' && message.mediaId,
                          // 表情包有媒体时按贴纸渲染（无气泡底、小尺寸）
                          emotion: isEmotionSticker(message),
                          // 语音自带气泡（微信式），外层气泡透明化
                          voice:
                            message.contentType === 'voice' &&
                            !!message.mediaId,
                          long: (message.text || '').length > 144,
                        }"
                      >
                        <MediaImage
                          v-if="
                            message.contentType === 'image' && message.mediaId
                          "
                          :media-id="message.mediaId"
                          :alt="`${actorLabel(message)} 发送的图片`"
                        />
                        <MediaImage
                          v-else-if="isEmotionSticker(message)"
                          :media-id="message.mediaId!"
                          :alt="`${actorLabel(message)} 发送的表情包`"
                          class="wf-emotion-sticker"
                        />
                        <VoiceMessage
                          v-else-if="message.contentType === 'voice' && message.mediaId"
                          :media-id="message.mediaId"
                          :alt="`${actorLabel(message)} 发送的语音`"
                        />
                        <template v-else>
                          <!-- 引用回复卡片 -->
                          <div
                            v-if="quotedMessage(message)"
                            class="wf-quote-card"
                          >
                            <span class="wf-quote-author">{{ actorLabel(quotedMessage(message)!) }}</span>
                            <span class="wf-quote-text">{{ quotedSummary(quotedMessage(message)!) }}</span>
                          </div>
                          <!-- @提及高亮 -->
                          <span v-if="!isEmotionMessage(message) && mentionSegments(bubbleText(message)).some(s => s.mention)"><template
                            v-for="(seg, si) in mentionSegments(bubbleText(message))"
                            :key="si"
                          ><span
                              v-if="seg.mention"
                              class="wf-mention"
                            >{{ seg.text }}</span><template v-else>{{ seg.text }}</template></template></span>
                          <!-- 普通文本 -->
                          <span v-else>{{
                            bubbleText(message)
                          }}</span>
                        </template>
                      </div>
                      <div class="wf-bubble-meta">
                        <span v-if="bubbleMetaLabel(message)">{{
                          bubbleMetaLabel(message)
                        }}</span>
                        <span>{{ messageTime(message.occurredAt) }}</span>
                        <span
                          v-if="isNonDefaultSendState(message)"
                          class="wf-bubble-state"
                          :class="{
                            bad:
                              message.sendState === 'failed' ||
                              message.sendState === 'unknown',
                          }"
                          >{{ sendStateLabel(message.sendState) }}</span
                        >
                        <span
                          v-if="
                            message.actorType !== 'agent' &&
                            message.direction === 'outbound' &&
                            message.sendState === 'failed'
                          "
                          class="wf-bubble-actions"
                        >
                          <button
                            :disabled="retryBusy"
                            @click="retryMessage(message)"
                          >
                            重试
                          </button>
                        </span>
                        <span
                          v-else-if="
                            message.actorType !== 'agent' &&
                            message.direction === 'outbound' &&
                            message.sendState === 'unknown'
                          "
                          class="wf-bubble-actions"
                        >
                          <button
                            :disabled="outcomeBusy"
                            @click="checkMessageOutcome(message)"
                          >
                            查询结果
                          </button>
                        </span>
                        <!-- 会话级人工反馈入口已下线 -->
                      </div>
                    </div>
                    <!-- AI 员工消息：右侧显示该员工的 DiceBear 头像（voxel-bot，
                         seed=员工标识；缺失/加载失败回退 AI 字标） -->
                    <img
                      v-if="message.actorType === 'agent' && message.actorAvatarUrl"
                      :src="message.actorAvatarUrl"
                      alt="AI 员工头像"
                      class="wf-msg-avatar wf-msg-agent-avatar"
                      @error="(e: Event) => (e.target as HTMLImageElement).style.display = 'none'"
                    />
                    <span
                      v-if="message.actorType === 'agent'"
                      class="wf-msg-avatar wf-msg-agent-icon"
                    >A</span>
                    <!-- 人工客服消息（outbound 非 agent）：右侧显示客服头像 -->
                    <StaffAvatar
                      v-else-if="message.direction === 'outbound' && message.actorType !== 'agent'"
                      :user-id="message.actorId || auth.user?.userId"
                      :avatar-url="auth.user?.avatarUrl"
                      :fallback-text="auth.user?.displayName || auth.user?.username || '我'"
                      :size="28"
                      class="wf-msg-avatar"
                    />
                  </div>
                </template>
              </div>
            </template>
          </div>
          <button
            v-if="!atBottom && newMessageCount > 0"
            class="wf-new-messages"
            @click="jumpToLatest"
          >
            有 {{ newMessageCount }} 条新消息 ↓
          </button>
          <!-- Agent 处理中：接管条代替 Composer（能看≠能回复；接管成功 Composer 转场淡入） -->
          <div
            v-if="canManualTakeover"
            class="wf-takeover-bar"
            :class="{ entering: takeoverTransition }"
          >
            <div class="wf-takeover-copy">
              <strong>Agent 正在处理此会话</strong>
              <span class="wf-muted"
                >接管后，Agent 将暂停回复，由你负责当前会话。</span
              >
            </div>
            <button
              class="wf-button primary"
              :disabled="actionBusy"
              @click="transition('take-over')"
            >
              {{ actionBusy ? "接管中…" : "接管处理" }}
            </button>
          </div>
          <!-- 微信客户端式输入栏：表情 / 图片 / 文件 + 文本 + 发送 -->
          <div
            v-else
            class="wx-composer"
            :class="{ entering: takeoverTransition }"
          >
            <div v-if="toolHint" class="wx-tool-hint">{{ toolHint }}</div>
            <div v-if="emojiPickerOpen" class="wx-emoji-picker">
              <button
                v-for="emoji in EMOJI_CHOICES"
                :key="emoji"
                type="button"
                class="wx-emoji-item"
                @click="insertEmoji(emoji)"
              >
                {{ emoji }}
              </button>
            </div>
            <!-- @提及联系人浮层 -->
            <div v-if="mentionOpen" class="wx-mention-popup">
              <div v-if="mentionContacts.length" class="wx-mention-list">
                <button
                  v-for="c in mentionContacts"
                  :key="c.id"
                  class="wx-mention-item"
                  @mousedown.prevent="selectMentionContact(c)"
                >
                  {{ c.name }}
                </button>
              </div>
              <div v-else class="wx-mention-empty">无匹配联系人</div>
            </div>
            <!-- 隐藏的文件输入 -->
            <input ref="imageInputRef" type="file" accept="image/*" style="display:none" @change="onImagePicked" />
            <input ref="fileInputRef" type="file" accept="*/*" style="display:none" @change="onFilePicked" />
            <div class="wx-composer-tools">
              <button
                type="button"
                class="wx-tool-button"
                title="表情"
                @click="toggleEmojiPicker"
              >
                😊
              </button>
              <button
                type="button"
                class="wx-tool-button"
                title="图片"
                :disabled="mediaUploading"
                @click="triggerImagePick"
              >
                <WfIcon name="upload" :size="17" />
              </button>
              <button
                type="button"
                class="wx-tool-button"
                title="文件"
                :disabled="mediaUploading"
                @click="triggerFilePick"
              >
                <WfIcon name="audit" :size="17" />
              </button>
              <span v-if="mediaUploading" class="wx-upload-progress">上传中…</span>
            </div>
            <!-- 引用回复预览条 -->
            <div v-if="replyTarget" class="wx-reply-preview">
              <span class="wx-reply-preview-text">回复 {{ actorLabel(replyTarget) }}：{{ replyTarget.text ? (replyTarget.text.length > 50 ? replyTarget.text.slice(0, 50) + '…' : replyTarget.text) : '〔非文本消息〕' }}</span>
              <button class="wx-reply-preview-close" @click="clearReplyTarget">×</button>
            </div>
            <textarea
              v-model="replyText"
              class="wx-input"
              rows="2"
              :placeholder="
                handoff?.state?.status === 'pending'
                  ? '先领取会话，再回复客户'
                  : handoff?.state?.status === 'in_progress' && !mine
                    ? '其他客服正在处理'
                    : '输入回复…'
              "
              :disabled="handoff?.state?.status === 'in_progress' && !mine"
              @focus="closeEmojiPicker"
              @input="onReplyInput"
              @keydown.meta.enter.prevent="send"
              @keydown.ctrl.enter.prevent="send"
            ></textarea>
            <div class="wx-composer-foot">
              <span v-if="mine" class="wf-section-caption"
                >Ctrl / ⌘ + Enter 发送 · 以通道回执为准</span
              ><button
                class="wx-send-button"
                :disabled="sending || !canReply"
                @click="send"
              >
                {{ sending ? "已受理" : "发送" }}
              </button>
            </div>
          </div>
        </template>
        <div v-else class="wf-empty">
          <div>
            <strong>选择一个会话开始处理</strong>
            <p>队列已按风险、等待状态和未读消息排序。</p>
          </div>
        </div>
      </section>

    <WfInspector
      :open="inspectorOpen"
      :title="inspectorTitle"
      :depth="
        inspectorView === 'context'
          ? 0
          : inspectorView === 'history' && historySelectedId
            ? 2
            : 1
      "
      @close="closeInspector"
      @back="inspectorBack"
    >
      <template v-if="inspectorView === 'context'">
        <section class="wf-inspector-section">
          <span class="wf-brief-label">当前任务</span>
          <p class="wf-brief-text">{{ ownershipLabel() }}</p>
          <p
            v-if="handoff && handoff.state?.status !== 'resolved'"
            class="wf-muted"
          >
            Agent 已暂停自动回复
          </p>
        </section>
        <section
          v-if="handoff"
          class="wf-inspector-section wf-inspector-link"
          role="button"
          tabindex="0"
          @click="openInspector('brief')"
          @keyup.enter="openInspector('brief')"
        >
          <span class="wf-brief-label">交接摘要</span>
          <p class="wf-brief-text">{{ briefingLine }}</p>
          <span class="wf-link">查看完整摘要 →</span>
        </section>
        <section
          v-if="handoff?.briefing?.confirmedFacts?.length || unresolvedShort.length"
          class="wf-inspector-section wf-inspector-link"
          role="button"
          tabindex="0"
          @click="openInspector('brief')"
          @keyup.enter="openInspector('brief')"
        >
          <span class="wf-brief-label">关键事实</span>
          <p class="wf-brief-text">
            {{ confirmedFactsLine }}<span
              v-if="unresolvedShort.length"
              > · 仍需确认：{{ unresolvedShort.join("、") }}</span
            >
          </p>
        </section>
        <section
          class="wf-inspector-section wf-inspector-link"
          role="button"
          tabindex="0"
          @click="openInspector('evidence')"
          @keyup.enter="openInspector('evidence')"
        >
          <span class="wf-brief-label">依据</span>
          <p class="wf-brief-text">{{
            evidence.length
              ? `${evidence.length} 条回答依据`
              : "尚无可展示的回答依据"
          }}</p>
          <span class="wf-link">查看依据 →</span>
        </section>
        <section
          v-if="selected"
          class="wf-inspector-section wf-inspector-link"
          role="button"
          tabindex="0"
          @click="openInspector('customer')"
          @keyup.enter="openInspector('customer')"
        >
          <span class="wf-brief-label">联系人</span>
          <p class="wf-brief-text">{{ contactDisplayName(selected) }}</p>
          <span class="wf-link">查看资料 →</span>
        </section>
        <section
          v-if="handoff?.cycles?.length"
          class="wf-inspector-section wf-inspector-link"
          role="button"
          tabindex="0"
          @click="openInspector('brief')"
          @keyup.enter="openInspector('brief')"
        >
          <span class="wf-brief-label">交接历史</span>
          <p class="wf-brief-text">{{ handoff.cycles.length }} 次交接</p>
        </section>
      </template>
      <template v-else-if="inspectorView === 'brief' && handoff">
        <section class="wf-inspector-section">
          <span class="wf-brief-label">为什么需要人工</span>
          <p class="wf-brief-text">
            {{
              handoff.briefing?.problemSummary ||
              "客户需要人工继续处理当前问题。"
            }}
          </p>
        </section>
        <section
          v-if="handoff.briefing?.confirmedFacts?.length"
          class="wf-inspector-section"
        >
          <span class="wf-brief-label">已确认</span>
          <p class="wf-brief-text">
            {{
              handoff.briefing.confirmedFacts
                .map((fact: any) => factLabel(fact))
                .join(" · ")
            }}
          </p>
        </section>
        <section
          v-if="handoff.briefing?.unresolvedItems?.length"
          class="wf-inspector-section"
        >
          <span class="wf-brief-label">仍需确认</span>
          <p class="wf-brief-text">
            {{ handoff.briefing.unresolvedItems.join("；") }}
          </p>
        </section>
        <section class="wf-inspector-section">
          <span class="wf-brief-label">当前风险</span>
          <span class="wf-risk-text" :class="selected?.riskLevel">{{
            riskLabel(selected?.riskLevel)
          }}</span>
        </section>
        <section class="wf-inspector-section">
          <span class="wf-brief-label">处理归属</span>
          <p class="wf-brief-text">{{ ownershipLabel() }}</p>
        </section>
        <section v-if="handoff.cycles?.length" class="wf-inspector-section">
          <span class="wf-brief-label">交接历史</span>
          <div class="wf-cycle-list">
            <div
              v-for="cycle in [...handoff.cycles].reverse()"
              :key="cycle.cycleId"
              class="wf-cycle-row"
            >
              <span class="wf-cycle-dot"></span>
              <div>
                <strong>{{ cycleStatusLabel(cycle.status) }}</strong>
                <span class="wf-muted">{{
                  new Date(cycle.createdAt).toLocaleString()
                }}</span>
                <span v-if="cycle.reason" class="wf-muted">
                  {{ reasonLabel(cycle.reason) || cycle.reason }}
                </span>
                <span
                  v-if="cycle.result === 'transferred'"
                  class="wf-muted"
                  >已转交</span
                >
              </div>
            </div>
          </div>
        </section>
      </template>
      <template v-else-if="inspectorView === 'evidence'">
        <template v-if="evidence.length">
          <div
            v-for="item in evidence"
            :key="item.evidenceId"
            class="wf-evidence-row"
            role="button"
            tabindex="0"
            @click="openEvidence(item)"
            @keyup.enter="openEvidence(item)"
          >
            <strong>{{
              item.title || item.sourceName || "知识证据"
            }}</strong
            ><span class="wf-muted">
              {{ item.provenance === "agent_retrieval" ? "Agent 最近检索 · " : "客服固定依据 · " }}{{
                item.excerpt || "暂无摘要"
              }}
            </span>
          </div>
          <button
            class="wf-link wf-link-button wf-evidence-more"
            @click="searchKnowledge"
          >
            检索更多知识
          </button>
        </template>
        <p v-else class="wf-muted">
          当前会话暂时没有可展示的回答依据。<button
            class="wf-link wf-link-button"
            @click="searchKnowledge"
          >
            检索知识
          </button>
        </p>
      </template>
      <template v-else-if="inspectorView === 'customer' && selected">
        <div class="wf-inspector-customer">
          <AvatarImage
            :contact-id="selected.contact?.contactId"
            :fallback-text="contactDisplayName(selected)"
            :size="40"
          />
          <h3>{{ contactDisplayName(selected) }}</h3>
          <p v-if="company" class="wf-muted">{{ company }}</p>
          <p v-if="profile?.agentEnabled === false" class="wf-brief-need">
            Agent 自动回复已暂停
          </p>
        </div>
        <section class="wf-inspector-section">
          <div class="wf-field">
            <label>内部备注</label
            ><textarea v-model="note" class="wf-textarea" rows="3"></textarea>
          </div>
          <div class="wf-field">
            <label>标签</label
            ><input
              v-model="tags"
              class="wf-input"
              placeholder="用顿号或逗号分隔"
            />
          </div>
          <button class="wf-button primary" @click="saveProfile">
            保存资料
          </button>
        </section>
        <section
          class="wf-inspector-section wf-inspector-link"
          role="button"
          tabindex="0"
          @click="openInspector('history')"
          @keyup.enter="openInspector('history')"
        >
          <span class="wf-brief-label">历史对话</span>
          <p class="wf-brief-text">查看该联系人的历史会话（只读）</p>
          <span class="wf-link">查看历史 →</span>
        </section>
      </template>
      <template v-else-if="inspectorView === 'history'">
        <template v-if="historySelectedId">
          <div class="wf-inspector-history-head">
            <button class="wf-link wf-link-button" @click="inspectorBack()">
              ← 全部历史
            </button>
            <span class="wf-muted">{{ contactDisplayName(selected) }} 的历史消息</span>
          </div>
          <div class="wf-history-readonly">
            <span class="wf-muted">历史记录 · 只读</span>
          </div>
          <div
            v-if="historyMessagesLoading"
            class="wf-skeleton wf-skeleton-title"
          ></div>
          <div v-else class="wf-history-messages">
            <div
              v-for="message in historyMessages"
              :key="message.messageId"
              class="wf-history-message"
              :class="{ outbound: message.direction === 'outbound' }"
            >
              <span class="wf-history-actor">{{
                message.actorType === "agent"
                  ? "Agent"
                  : message.direction === "outbound"
                    ? "人工客服"
                    : "客户"
              }}</span>
              <template v-if="message.contentType === 'image' && message.mediaId">
                <MediaImage
                  :media-id="message.mediaId"
                  :alt="`${message.actorType === 'agent' ? 'Agent' : '客户'} 发送的图片`"
                />
              </template>
              <template v-else-if="message.contentType === 'voice' && message.mediaId">
                <VoiceMessage
                  :media-id="message.mediaId"
                  :alt="`${message.actorType === 'agent' ? 'Agent' : '客户'} 发送的语音`"
                />
              </template>
              <p v-else>{{ message.text || "〔非文本消息〕" }}</p>
              <span class="wf-muted">{{
                new Date(message.occurredAt).toLocaleString()
              }}</span>
            </div>
          </div>
          <button
            v-if="historyMessagesNextCursor"
            class="wf-link wf-link-button"
            :disabled="historyMessagesLoading"
            @click="loadMoreHistoryMessages()"
          >
            加载更早消息
          </button>
        </template>
        <template v-else>
          <div class="wf-history-readonly">
            <span class="wf-muted">历史记录 · 只读（不可接管或回复）</span>
          </div>
          <div
            v-if="historyLoading"
            class="wf-skeleton wf-skeleton-title"
          ></div>
          <div v-else-if="historyConversations.length" class="wf-history-list">
            <button
              v-for="item in historyConversations"
              :key="item.conversationId"
              class="wf-history-row"
              :class="{ active: item.conversationId === selectedId }"
              @click="openHistoryConversation(item.conversationId)"
            >
              <span class="wf-history-date">{{
                item.latestMessageAt
                  ? new Date(item.latestMessageAt).toLocaleDateString("zh-CN", {
                      month: "2-digit",
                      day: "2-digit",
                    })
                  : "—"
              }}</span>
              <span class="wf-history-preview">{{
                item.latestMessageText || "暂无消息"
              }}</span>
              <span v-if="item.conversationId === selectedId" class="wf-muted"
                >当前</span
              >
            </button>
            <button
              v-if="historyNextCursor"
              class="wf-link wf-link-button"
              :disabled="historyLoading"
              @click="loadHistory(true)"
            >
              加载更多
            </button>
          </div>
          <p v-else class="wf-muted">该联系人暂无其他会话。</p>
        </template>
      </template>
    </WfInspector>
    </div>

    <div
      v-if="transferOpen"
      class="wf-modal-mask"
      @click.self="transferOpen = false"
    >
      <div class="wf-modal wf-modal-narrow">
        <div class="wf-modal-head">
          <h3>转交处理</h3>
          <button class="wf-icon-button" @click="transferOpen = false">×</button>
        </div>
        <div class="wf-modal-body">
          <div class="wf-field">
            <label>转交原因</label>
            <input
              v-model="transferReason"
              class="wf-input"
              placeholder="例如：需要设备团队处理"
            />
          </div>
          <div class="wf-queue-tabs wf-upload-sources">
            <button
              class="wf-tab"
              :class="{ active: transferTargetType === 'user' }"
              @click="transferTargetType = 'user'; transferTarget = ''"
            >
              转给客服
            </button>
            <button
              v-if="transferQueues.length"
              class="wf-tab"
              :class="{ active: transferTargetType === 'queue' }"
              @click="transferTargetType = 'queue'; transferTarget = ''"
            >
              专业队列
            </button>
          </div>
          <p v-if="transferTargetType === 'queue'" class="wf-muted">
            当前负责人释放，会话进入队列等待成员接手。
          </p>
          <p v-else class="wf-muted">
            等待目标客服接受；拒绝或超时后按服务端规则处理。
          </p>
          <div v-if="transferTargetType === 'user'" class="wf-assignee-list">
            <button
              v-for="user in assignees"
              :key="user.userId"
              class="wf-assignee-row"
              :class="{ active: transferTarget === user.userId }"
              @click="transferTarget = user.userId"
            >
              {{ agentDisplayName(user) }}
            </button>
            <div v-if="!assignees.length" class="wf-muted">暂无可转交的客服。</div>
          </div>
          <div v-else class="wf-assignee-list">
            <button
              v-for="queue in transferQueues"
              :key="queue.queueId"
              class="wf-assignee-row"
              :class="{ active: transferTarget === queue.queueId }"
              @click="transferTarget = queue.queueId"
            >
              {{ queue.displayName }}
              <span class="wf-muted">等待队列成员接手</span>
            </button>
            <div v-if="!transferQueues.length" class="wf-muted">
              当前没有可接收转交的队列。
            </div>
          </div>
        </div>
        <div class="wf-modal-foot">
          <button class="wf-button" @click="transferOpen = false">取消</button
          ><button
            class="wf-button primary"
            :disabled="!transferTarget || !transferReason.trim() || actionBusy"
            @click="doTransfer"
          >
            {{ actionBusy ? "转交中" : "确认转交" }}
          </button>
        </div>
      </div>
    </div>
    <div
      v-if="settingsOpen && profile"
      class="wf-modal-mask"
      @click.self="settingsOpen = false"
    >
      <div class="wf-modal wf-modal-narrow">
        <div class="wf-modal-head">
          <h3>会话设置</h3>
          <button class="wf-icon-button" @click="settingsOpen = false">×</button>
        </div>
        <div class="wf-modal-body">
          <label class="wf-checkbox-row"
            ><input
              v-model="profile.agentEnabled"
              type="checkbox"
              :disabled="handoff?.state?.status === 'in_progress' && !mine"
            />允许 Agent 自动回复</label
          >
          <p class="wf-muted">
            关闭后，该客户的后续消息不会由 Agent 自动回复。
          </p>
        </div>
        <div class="wf-modal-foot">
          <button class="wf-button" @click="settingsOpen = false">取消</button
          ><button class="wf-button primary" @click="saveProfile">保存</button>
        </div>
      </div>
    </div>
    <!-- 消息右键菜单 -->
    <Teleport to="body">
      <div
        v-if="messageMenu"
        class="wf-msg-context-menu"
        :style="{ left: messageMenu.x + 'px', top: messageMenu.y + 'px' }"
      >
        <button class="wf-msg-context-item" @click="handleMenuReply(messageMenu.message)">↩ 回复</button>
        <button class="wf-msg-context-item" @click="handleMenuPoke(messageMenu.message)">👋 拍一拍</button>
      </div>
    </Teleport>
    <!-- 点击其他地方关闭右键菜单 -->
    <div v-if="messageMenu" class="wf-msg-context-backdrop" @click="closeMessageMenu" @contextmenu.prevent="closeMessageMenu"></div>
  </div>
</template>

<style scoped>
/* ---------- 微信客户端式列表 ---------- */
.wx-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  cursor: pointer;
}
.wx-row:hover {
  background: var(--wf-surface-hover, rgba(0, 0, 0, 0.035));
}
.wx-row.active {
  background: var(--wf-surface-active, rgba(0, 0, 0, 0.06));
}
.wx-row-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.wx-row-top,
.wx-row-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.wx-row-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--wf-text, #17181a);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wx-row-time,
.wx-row-flag {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--wf-text-tertiary, #9aa0a6);
  font-variant-numeric: tabular-nums;
}
.wx-row-flag {
  color: var(--wf-risk-high, #d93025);
  font-weight: 700;
}
.wx-row-preview {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--wf-text-secondary, #5f6368);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wx-row-unread {
  flex-shrink: 0;
  min-width: 17px;
  height: 17px;
  padding: 0 5px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #ea4335;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
}

/* ---------- 输入栏 ---------- */
.wx-composer {
  position: relative;
  border-top: 1px solid var(--wf-border, rgba(0, 0, 0, 0.08));
  background: var(--wf-surface, #fff);
  padding: 6px 12px 8px;
}
.wx-tool-hint {
  position: absolute;
  top: -34px;
  left: 50%;
  transform: translateX(-50%);
  padding: 5px 12px;
  border-radius: 8px;
  background: rgba(23, 24, 26, 0.86);
  color: #fff;
  font-size: 12px;
  white-space: nowrap;
  z-index: 5;
}
.wx-composer-tools {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-bottom: 4px;
}
.wx-tool-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--wf-text-secondary, #5f6368);
  font-size: 16px;
  cursor: pointer;
}
.wx-tool-button:hover {
  background: var(--wf-surface-hover, rgba(0, 0, 0, 0.05));
}
.wx-emoji-picker {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 8px;
  z-index: 20;
  display: grid;
  grid-template-columns: repeat(8, 34px);
  gap: 2px;
  padding: 8px;
  border: 1px solid var(--wf-border, rgba(0, 0, 0, 0.1));
  border-radius: 12px;
  background: var(--wf-surface, #fff);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.14);
}
.wx-emoji-item {
  width: 34px;
  height: 32px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  font-size: 18px;
  cursor: pointer;
}
.wx-emoji-item:hover {
  background: var(--wf-surface-hover, rgba(0, 0, 0, 0.05));
}
.wx-input {
  width: 100%;
  resize: none;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--wf-text, #17181a);
  font: inherit;
  font-size: 13px;
  line-height: 1.55;
  min-height: 44px;
}
.wx-composer-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}
.wx-send-button {
  min-width: 64px;
  height: 28px;
  padding: 0 14px;
  border: 0;
  border-radius: 7px;
  background: var(--wf-border, rgba(0, 0, 0, 0.09));
  color: var(--wf-text-secondary, #9aa0a6);
  font-size: 13px;
  cursor: not-allowed;
}
.wx-send-button:not(:disabled) {
  background: #c6e3bf;
  color: #14300e;
  font-weight: 700;
  cursor: pointer;
}
.wx-send-button:not(:disabled):hover {
  background: #b3dcab;
}
/* ---------- 三区列表（等待处理/我处理的/其他对话） ---------- */
.wf-queue-mode {
  display: flex;
  gap: 4px;
  padding: 6px 10px 2px;
  border-bottom: 1px solid var(--wf-border, rgba(0, 0, 0, 0.06));
}
.wf-mode-btn {
  min-height: 26px;
  padding: 2px 12px;
  border: 1px solid var(--wf-border, rgba(0, 0, 0, 0.1));
  border-radius: 999px;
  background: var(--wf-surface, #fff);
  color: var(--wf-text-secondary, #5f6368);
  font-size: 12px;
  cursor: pointer;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
}
.wf-mode-btn.active {
  background: #e8f0fe;
  border-color: #a8c7fa;
  color: #1a56c4;
  font-weight: 700;
}
.wf-mode-link {
  margin-left: auto;
}
/* ---------- 联系人页搜索栏 ---------- */
.wf-queue-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px 4px;
  border-bottom: 1px solid var(--wf-border, rgba(0, 0, 0, 0.06));
}
.wf-queue-search .wf-search {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--wf-border, rgba(0, 0, 0, 0.1));
  border-radius: 999px;
  background: var(--wf-surface, #fff);
}
.wf-queue-section {
  margin: 2px 0;
}
.wf-queue-section-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px 3px;
  font-size: 12px;
  font-weight: 700;
}
.wf-queue-section-head.tone-attention {
  color: #c5221f;
}
.wf-queue-section-head.tone-mine {
  color: #1a56c4;
}
.wf-queue-section-head.tone-others {
  color: #5f6368;
}
.wf-queue-section-count {
  min-width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: rgba(0, 0, 0, 0.06);
  font-size: 11px;
  font-weight: 600;
}
.wf-queue-section-empty {
  padding: 4px 12px 6px;
  color: var(--wf-text-tertiary, #9aa0a6);
  font-size: 12px;
}
.wf-queue-loading {
  padding: 8px 12px;
}
/* ---------- 消息气泡头像 ---------- */
.wf-bubble-row.them {
  gap: 6px;
  align-items: flex-start;
}
.wf-bubble-row.me {
  gap: 6px;
  align-items: flex-start;
}
.wf-msg-avatar {
  flex-shrink: 0;
  align-self: flex-start;
  margin-top: 2px;
}
.wf-msg-agent-icon {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--wf-primary) 12%, var(--wf-surface));
  color: #1a56c4;
  font-weight: 800;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--wf-primary) 25%, transparent);
}
/* AI 员工 DiceBear 头像；加载失败隐藏 <img> 后仍显示下方 AI 字标 */
.wf-msg-agent-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--wf-surface);
}
.wf-msg-agent-avatar + .wf-msg-agent-icon {
  display: none;
}
/* ---------- 媒体上传 & 录音 ---------- */
.wx-upload-progress {
  font-size: 11px;
  color: var(--wf-text-secondary, #5f6368);
  margin-left: 6px;
  animation: wx-pulse 1s ease-in-out infinite;
}
@keyframes wx-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
/* ---------- 引用回复预览条 ---------- */
.wx-reply-preview {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  margin-bottom: 4px;
  border-left: 3px solid var(--wf-primary, #1a73e8);
  background: rgba(26, 115, 232, 0.06);
  border-radius: 0 6px 6px 0;
  font-size: 12px;
}
.wx-reply-preview-text {
  flex: 1;
  min-width: 0;
  color: var(--wf-text-secondary, #5f6368);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wx-reply-preview-close {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--wf-text-tertiary, #9aa0a6);
  font-size: 14px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.wx-reply-preview-close:hover {
  background: rgba(0, 0, 0, 0.06);
}
/* ---------- @提及浮层 ---------- */
.wx-mention-popup {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 8px;
  z-index: 25;
  min-width: 160px;
  max-height: 180px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--wf-border, rgba(0, 0, 0, 0.1));
  border-radius: 10px;
  background: var(--wf-surface, #fff);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
}
.wx-mention-item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  font-size: 13px;
  color: var(--wf-text, #17181a);
  cursor: pointer;
}
.wx-mention-item:hover {
  background: var(--wf-surface-hover, rgba(0, 0, 0, 0.05));
}
.wx-mention-empty {
  padding: 8px 10px;
  font-size: 12px;
  color: var(--wf-text-tertiary, #9aa0a6);
}
/* ---------- 消息右键菜单 ---------- */
.wf-msg-context-menu {
  position: fixed;
  z-index: 9999;
  min-width: 120px;
  padding: 4px;
  border: 1px solid var(--wf-border, rgba(0, 0, 0, 0.1));
  border-radius: 10px;
  background: var(--wf-surface, #fff);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16);
}
.wf-msg-context-item {
  display: block;
  width: 100%;
  padding: 7px 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  font-size: 13px;
  color: var(--wf-text, #17181a);
  cursor: pointer;
}
.wf-msg-context-item:hover {
  background: var(--wf-surface-hover, rgba(0, 0, 0, 0.05));
}
.wf-msg-context-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9998;
}
/* ---------- @提及渲染高亮 ---------- */
.wf-mention {
  color: #1a73e8;
  font-weight: 600;
}
</style>

