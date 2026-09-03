/**
 * 群聊显示名兜底（纯函数，两端共用逻辑参考）。
 *
 * 微信 4.x 的群名不存 contact.db 的 nick_name 列（存在 UI 层的群设置里，
 * 自动化链路拿不到），未设群名的群 displayName 只有裸 ID
 * （如 45868444838@chatroom）。显示时兜底为「群聊 xxxxx」（ID 前 5 位），
 * 避免把长 ID 露给用户。
 */

/** 判断联系人 ID 是否为群聊 */
export function isChatroomContact(contactId: string | null | undefined): boolean {
  return typeof contactId === "string" && contactId.includes("@chatroom");
}

/**
 * 群聊显示名兜底：已有可读名（非裸 ID）原样返回；裸 ID → 「群聊 xxxxx」。
 * @param displayName 当前 displayName（可能等于裸 ID）
 * @param contactId 联系人 ID（用于提取数字段）
 */
export function groupDisplayName(
  displayName: string | null | undefined,
  contactId: string | null | undefined,
): string | null {
  if (!isChatroomContact(contactId)) return displayName ?? null;
  const name = displayName?.trim() ?? "";
  // 名字可读（不是裸 @chatroom ID）就直接用
  if (name !== "" && !name.includes("@chatroom")) return name;
  // 从 contactId 提取群号数字段（wxid 账号隔离格式里取最后一段的群号部分）
  const idSource = contactId ?? name;
  const rawGroup = idSource.split(":").at(-1) ?? idSource;
  const digits = rawGroup.replace("@chatroom", "").replace(/\D/g, "");
  const suffix = digits.slice(-5) || rawGroup.slice(0, 5);
  return `群聊 ${suffix}`;
}
