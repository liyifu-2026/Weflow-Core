/**
 * 联系人标签工具模块
 * 处理联系人标签的解析、去重和格式化。
 */
/** 将逗号分隔的标签字符串解析为去重后的标签数组，最多 50 个 */
export function normalizeContactTags(value: string): string[] {
  const unique = new Set(
    value
      .split(/[，,\n]/)
      .map((tag) => tag.trim())
      .filter(Boolean),
  );
  return [...unique].slice(0, 50);
}

/** 将标签数组格式化为中文逗号分隔的编辑用字符串 */
export function contactTagsInput(tags: string[]): string {
  return tags.join("，");
}

/** 联系人资料的最小显示字段子集（displayName 的输入契约） */
export type ContactDisplayFields = {
  sharedAlias?: string | null;
  channelDisplayName?: string | null;
  channelNickname?: string | null;
  channelRemark?: string | null;
  channelContactId?: string | null;
};

/**
 * 联系人显示名：唯一优先链定义（此前 4 处各自实现且顺序不一致）。
 * 共享别名 > 渠道显示名 > 渠道备注 > 渠道昵称 > 渠道 ID 尾号。
 */
export function contactDisplayName(profile: ContactDisplayFields): string {
  const preferred =
    profile.sharedAlias?.trim() ||
    profile.channelDisplayName?.trim() ||
    profile.channelRemark?.trim() ||
    profile.channelNickname?.trim();
  if (preferred) return preferred;
  const id = profile.channelContactId?.trim();
  return id ? `客户 · ${id.slice(-8)}` : "客户";
}
