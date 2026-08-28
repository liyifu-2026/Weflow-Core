/**
 * 消息展示分类模块
 * 根据消息的发送者类型和方向，确定消息在 UI 中的展示样式；
 * 并提供拍一拍与表情包消息的文本化展示规则。
 */
export type MessageKind = "agent" | "manual" | "customer" | "system";

/** 判断消息展示类型：AI 自动回复、人工客服回复、客户消息或系统消息 */
export function messageKind(
  actorType: string,
  direction: string,
): MessageKind {
  if (actorType === "agent") return "agent";
  if (actorType === "user") return "manual";
  if (direction === "inbound") return "customer";
  return "system";
}

/** 拍一拍消息的默认提示文案 */
const PAT_NOTICE_FALLBACK = "对方拍了拍你";

/**
 * 拍一拍消息（Core 以 contentType "pat" 落库）以系统提示样式居中展示，
 * 不进入聊天气泡；非 pat 消息返回 null 走常规渲染。
 */
export function patNoticeText(message: {
  contentType: string;
  text: string;
}): string | null {
  if (message.contentType !== "pat") return null;
  const text = message.text.trim();
  return text || PAT_NOTICE_FALLBACK;
}

/** 表情包消息缺失含义时的兜底文案 */
const EMOTION_FALLBACK = "[表情包]表情";

/**
 * 表情包消息（contentType "emotion"）不渲染图片截图，一律按纯文本
 * `[表情包]<含义>` 展示；含义为空时兜底 `[表情包]表情`。
 * 非 emotion 消息返回 null 走常规渲染。
 */
export function emotionDisplayText(message: {
  contentType: string;
  text: string;
}): string | null {
  if (message.contentType !== "emotion") return null;
  const text = message.text.trim();
  return text || EMOTION_FALLBACK;
}

// ---------- @提及分段 ----------
export type MentionSegment = { text: string; mention: boolean };

/**
 * 将消息文本按 @提及 模式分段。
 * 返回交替的普通文本和提及文本段，供 UI 渲染高亮。
 */
export function mentionSegments(text: string): MentionSegment[] {
  if (!text) return [];
  const segments: MentionSegment[] = [];
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
