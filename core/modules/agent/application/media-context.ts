/**
 * 媒体感知的上下文装配规则（Phase 4 视觉直读）。
 *
 * 图片不再止步于 caption/占位：有描述（旧 caption 或模型自写
 * media_notes）直接给观察文本；无描述但原图可取时注入"可看图"
 * 信号与消息 ID——模型决策轮据此用 fetch_url/原图直读获得一手
 * 视觉信息。语音行为保持既有转写语义。
 */

export type MediaMessageInput = {
  contentType: string;
  text?: string | null;
  mediaDescription?: string | null;
  originalImageUrl?: string | null;
  messageId?: string | null;
};

export function mediaAwareMessageText(message: MediaMessageInput): string {
  switch (message.contentType) {
    case "image":
      if (message.mediaDescription) {
        return `图片观察：${message.mediaDescription}`;
      }
      if (message.originalImageUrl) {
        return `[对方发送了一张图片，原图可查看（用 fetch_url 抓取 ${message.originalImageUrl} 后描述；消息ID ${message.messageId ?? ""}）]`;
      }
      return "[对方发送了一张图片，当前无法查看内容]";
    case "voice":
      if (message.mediaDescription) {
        return `语音转写：${message.mediaDescription}`;
      }
      return message.text
        ? `语音转写：${message.text}`
        : "[对方发来一条语音，转写不可用]";
    default:
      return message.text ?? "";
  }
}
