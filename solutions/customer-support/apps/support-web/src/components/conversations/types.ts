/**
 * 会话工作台共享类型与纯函数。
 * 从 ConversationsV2.vue 抽出，逻辑零改动 —— 仅供 conversations/ 子组件引用。
 */
export type Conversation = {
  conversationId: string;
  latestMessageAt?: string;
  latestMessage?: { text?: string };
  matchedMessage?: { text?: string; occurredAt?: string };
  /** 会话类型：group = 群聊（Core 由 channel ref @chatroom 派生） */
  chatType?: "private" | "group";
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
export type ConversationPermissions = {
  canView: boolean;
  canManualTakeover: boolean;
  canReply: boolean;
  canTransfer: boolean;
  canFinish: boolean;
};
export type Message = {
  messageId: string;
  actorType: string;
  direction: string;
  text?: string;
  contentType?: string;
  mediaId?: string;
  /** 媒体细分类型（Core mediaAssets.kind）：图片/文件卡片据此渲染 */
  mediaKind?: string | null;
  /** 文件名（出站=暂存原名；入站=Host 上报原名） */
  mediaFileName?: string | null;
  sendState?: string;
  occurredAt: string;
  actorId?: string;
  /** AI 员工头像（平台 DiceBear 代理 URL）；人工/客户消息为 null */
  actorAvatarUrl?: string | null;
  /** 群聊消息的发送者昵称（Core 由联系人资料解析；私聊恒为 null） */
  senderName?: string | null;
  replyToChannelMessageId?: string;
  mentionContactRefs?: string[];
  /** AI 回复批次键（回合气泡把「回合完成」钉在该轮最后一条回复后） */
  replyBatchId?: string | null;
};
export type Evidence = {
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
export type SectionScope = "attention" | "mine" | "others";
export type QueueSectionKey = SectionScope;

/** 回合侧轨（TurnRail）的一个点：AI 回复轮 / 人工处理轮 / 唤醒跟进 */
export type RailRound = {
  key: string;
  kind: "agent" | "human" | "wake";
  /** ok=已回复/已完成 warn=未回复 error=失败 running=处理中 info=中性 */
  tone: "ok" | "warn" | "error" | "running" | "info";
  title: string;
  timeText: string;
  /** 排序用（升序时间线） */
  occurredAt: string;
  /** 点击跳转锚定的消息 id；null = 进行中滚到底部，其余滚到顶部 */
  anchorMessageId: string | null;
  /** 卡片摘要行（时间/耗时/错误/处理人等） */
  lines: string[];
  /** 客户触发消息摘要（AI 轮） */
  question?: string;
  /** AI 回复摘要（已回复轮） */
  reply?: string;
  /** 人工首条消息摘要（人工轮） */
  excerpt?: string;
  /** 实时思维链（进行中 AI 轮，live 轮询） */
  reasoning?: string | null;
  /** 决策轨迹入口（AI 轮 / 唤醒） */
  turnId?: string;
};

export function priority(item: Conversation) {
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

export function riskLabel(risk?: string | null) {  return risk === "high" ? "高风险" : risk === "medium" ? "需关注" : "常规";
}

export function rowSummary(item: Conversation): string {
  const text = item.latestMessage?.text || item.matchedMessage?.text || "";
  const trimmed = text.trim();
  // 上游偶发把内部 user_id 当消息文本落库（ISS C-1）：列表里不展示原始 id
  if (/^user_[A-Za-z0-9]+$/.test(trimmed)) return "消息内容暂不可见";
  return trimmed || "暂无消息";
}

export function rowTimeLabel(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

export function actorLabel(message: Message) {
  return message.actorType === "agent"
    ? "Agent"
    : message.direction === "outbound"
      ? "人工客服"
      : "客户";
}

// ---------- 微信客户端式消息渲染 ----------
// 表情包：不渲染图片截图，直接显示纯文本「[表情包]<含义>」。
export function isEmotionMessage(message: Message): boolean {
  return message.contentType === "emotion";
}
export function emotionLabel(message: Message): string {
  const meaning = (message.text || "").trim();
  return meaning ? `[表情包]${meaning}` : "[表情包]";
}
/** 表情包贴纸：emotion 类型，或带「[表情包]」文本的图片消息（有媒体） */
export function isEmotionSticker(message: Message): boolean {
  return (
    (message.contentType === "emotion" ||
      (message.contentType === "image" &&
        (message.text || "").includes("[表情包]"))) &&
    Boolean(message.mediaId)
  );
}
// 拍一拍：系统样式提示条，显示「对方拍了拍你」。
export function isPatMessage(message: Message): boolean {
  return (
    message.contentType === "pat" ||
    (message.actorType === "system" && /拍了拍/.test(message.text || ""))
  );
}
/** 气泡正文：表情包走文本含义；其余按原逻辑。 */
export function bubbleText(message: Message): string {
  if (isEmotionMessage(message)) return emotionLabel(message);
  return message.text || "〔非文本消息〕";
}
/** 消息是否渲染为图片：contentType=image（回声行）或 mediaKind=image */
export function isImageMessage(message: Message): boolean {
  return message.contentType === "image" || message.mediaKind === "image";
}
/** 消息是否渲染为文件卡片：mediaKind=file（含融合后的 ct=media 行） */
export function isFileMessage(message: Message): boolean {
  return message.mediaKind === "file" || message.contentType === "file";
}
/** 消息是否渲染为语音：mediaKind=voice 或 contentType=voice */
export function isVoiceMsg(message: Message): boolean {
  return message.mediaKind === "voice" || message.contentType === "voice";
}
/** 消息是否渲染为视频：mediaKind=video 或 contentType=video（入站视频） */
export function isVideoMsg(message: Message): boolean {
  return message.mediaKind === "video" || message.contentType === "video";
}
/** 引用卡片摘要：取原消息前 40 字符 */
export function quotedSummary(quoted: Message): string {
  const text = (quoted.text || "").trim();
  if (!text) return "〔非文本消息〕";
  return text.length > 40 ? text.slice(0, 40) + "…" : text;
}
/** 将消息文本中的 @提及 渲染为高亮 span 段。
 *  返回交替的 { text, isMention } 段列表，供 v-for 渲染。 */
export function mentionSegments(
  text: string,
): Array<{ text: string; mention: boolean }> {
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
// 状态降噪：正常（sent/confirmed/observed）不显示；仅发送中/拦截/取消/失败/未知显示。
// 与 Core 词汇表（send-states.ts，CHECK 约束 8 态）对齐；sending/accepted 为历史兼容。
export function isNonDefaultSendState(message: Message): boolean {
  return ["pending", "submitting", "held", "cancelled", "failed", "unknown"].includes(
    message.sendState || "",
  );
}
export function messageTime(value: string) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function sendStateLabel(state?: string) {
  if (!state) return "";
  if (state === "confirmed" || state === "observed" || state === "sent") return "已发送";
  if (state === "failed") return "发送失败";
  if (state === "unknown") return "结果未知";
  if (state === "pending" || state === "submitting" || state === "sending") return "发送中";
  if (state === "held") return "已拦截";
  if (state === "cancelled") return "已取消";
  if (state === "accepted") return "已受理";
  return state;
}
