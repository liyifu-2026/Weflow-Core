/**
 * 媒体感知的上下文装配规则。
 *
 * 图片有描述（旧 caption 或模型自写 media_notes）直接给观察文本；
 * 无描述时渲染诚实占位（模型知道存在图片但无法查看，禁止编造）。
 * 语音行为保持既有转写语义。
 *
 * 注：曾在此注入「原图可查看（用 fetch_url 抓取）」的可看图信号，
 * 但 fetch_url 仅支持文本类内容、也不存在可用的看图工具——该信号是
 * 死路（模型照做必然工具失败，曾进一步触发转人工），已移除。
 */

export type MediaMessageInput = {
  contentType: string;
  text?: string | null;
  mediaDescription?: string | null;
  messageId?: string | null;
};

export function mediaAwareMessageText(message: MediaMessageInput): string {
  switch (message.contentType) {
    case "image":
      if (message.mediaDescription) {
        return `图片观察：${message.mediaDescription}`;
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
