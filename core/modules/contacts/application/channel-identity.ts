/**
 * Channel 身份派生（ADR-0005 多账号隔离）—— 账号归一化、会话 ID 与
 * 联系人 ID 的唯一权威。
 *
 * 曾以三种方言散落（ingest 的内联 ID 模板、联系人同步的本地
 * normalizeAccount 副本、provider 的 `?? "default"`），任一处漂移都会
 * 造成同一客户被拆进两个会话的裂脑。default 账号保持旧格式 ID
 * （channel:<ref> / contact:channel:<ref>），兼容存量数据不回写；
 * 非 default 账号携带 account 段实现隔离。
 */

/** 平台通道标识：用于会话/联系人/消息 ID 前缀与 channel 列（通道无关） */
export const CHANNEL_KIND = "channel";

/** 归一化账号标识：空值回落 "default"（ADR-0005）。 */
export function normalizeChannelAccount(
  account: string | null | undefined,
): string {
  const trimmed = account?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "default";
}

/**
 * 会话 ID：default 账号保持旧格式（channel:<ref>），非 default 账号带
 * account 段（channel:<account>:<ref>）。与 contactIdForChannel 的
 * default 兼容策略一致。
 */
export function conversationIdForChannel(
  channel: string,
  conversationRef: string,
  account?: string | null,
): string {
  const acc = normalizeChannelAccount(account);
  return acc === "default"
    ? `${channel}:${conversationRef}`
    : `${channel}:${acc}:${conversationRef}`;
}

/**
 * 联系人 ID：default 账号保持旧格式（contact:channel:<ref>），非 default
 * 账号携带 account 段（contact:channel:<account>:<ref>）实现隔离。
 */
export function contactIdForChannel(
  channel: string,
  channelContactId: string,
  account?: string | null,
): string {
  const acc = normalizeChannelAccount(account);
  return acc === "default"
    ? `contact:${channel}:${channelContactId}`
    : `contact:${channel}:${acc}:${channelContactId}`;
}
