/**
 * 群聊显示名兜底（纯函数）。
 *
 * 部分通道（如微信）的群名不在联系人同步范围内，未设群名的群
 * displayName 只有裸通道群 ID。显示时兜底为「群聊 xxxxx」（ID 尾段），
 * 避免把长 ID 露给用户。是否群聊由调用方以落库 chatType 事实传入
 * （ADR-0010）——本模块不再从 ID 形态猜测会话类型。
 */

/**
 * 群聊显示名兜底：已有可读名原样返回；裸 ID → 「群聊 xxxxx」。
 * @param displayName 当前 displayName（可能等于裸 ID）
 * @param contactId 联系人 ID（用于提取展示尾段）
 * @param isGroup 会话类型事实（conversations.chat_type === "group"）
 */
export function groupDisplayName(
  displayName: string | null | undefined,
  contactId: string | null | undefined,
  isGroup: boolean,
): string | null {
  if (!isGroup) return displayName ?? null;
  const name = displayName?.trim() ?? "";
  const idSource = contactId ?? name;
  // 名字可读（不是裸通道群 ID）就直接用：displayName 若是 contactId 的
  // 子串，说明它就是同步自裸 ID 的值，不能当可读名。
  if (name !== "" && !idSource.includes(name)) return name;
  // 从 ID 提取展示尾段（剥离 @ 后的通道后缀；无数字时取前 5 字符）
  const base = idSource.split("@")[0] ?? idSource;
  const digits = base.replace(/\D/g, "");
  const suffix = digits.slice(-5) || base.slice(0, 5);
  return `群聊 ${suffix}`;
}
